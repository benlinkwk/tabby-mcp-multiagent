import * as z from 'zod';
import stripAnsi from 'strip-ansi';
import { createErrorResponse, createJsonResponse, createSuccessResponse } from '../../type/types';
import { BaseTool } from './base-tool';
import { BaseTerminalTabComponentWithId, ExecToolCategory } from '../terminal';
import { McpLoggerService } from '../../services/mcpLogger.service';
import { CommandOutputStorageService } from '../../services/commandOutputStorage.service';
import { CommandHistoryManagerService } from '../../services/commandHistoryManager.service';
import { AppService, ConfigService } from 'tabby-core';
import { DialogService } from '../../services/dialog.service';
import { RunningCommandsManagerService } from '../../services/runningCommandsManager.service';

/**
 * Per-call context from the MCP request
 */
interface ExecContext {
  // Request cancelled by the client (e.g. the user pressed Esc)
  signal?: AbortSignal;
  // The client's SSE connection closed
  connectionClosed?: AbortSignal;
  // MCP session id of the client
  clientId?: string;
  // Interrupt the command after this long
  timeoutMs?: number;
}

/**
 * Tool for executing a command in a terminal session and retrieving the output.
 *
 * This tool allows executing shell commands in terminal sessions and handles
 * command execution, output capture, and result formatting.
 */
export class ExecCommandTool extends BaseTool {
  // Maximum number of lines to return in a single response
  private readonly MAX_LINES_PER_RESPONSE = 250;
  private outputStorage: CommandOutputStorageService;
  private commandHistoryManager: CommandHistoryManagerService;
  // Default typing delay in milliseconds
  private readonly DEFAULT_TYPING_DELAY = 1;
  // Maximum retry attempts
  private readonly MAX_RETRY_ATTEMPTS = 3;
  // How long to wait for a disconnected tab to reconnect
  private readonly RECONNECT_TIMEOUT_MS = 30000;
  // How long to wait for another client's command on the same tab
  private readonly TAB_WAIT_MS = 30000;
  // Default time before a command is interrupted
  private readonly DEFAULT_TIMEOUT_SEC = 600;

  constructor(
    private execToolCategory: ExecToolCategory,
    logger: McpLoggerService,
    private config: ConfigService,
    private dialogService: DialogService,
    private app: AppService,
    private runningCommandsManager: RunningCommandsManagerService,
    outputStorage?: CommandOutputStorageService,
    commandHistoryManager?: CommandHistoryManagerService
  ) {
    super(logger);
    // If outputStorage is not provided, create a new instance
    this.outputStorage = outputStorage || new CommandOutputStorageService(logger);
    // CommandHistoryManager should always be provided as singleton from DI
    if (!commandHistoryManager) {
      throw new Error('CommandHistoryManagerService must be provided');
    }
    this.commandHistoryManager = commandHistoryManager;
  }

  /**
   * Execute command with retry logic
   */
  private async executeCommandWithRetry(
    command: string,
    session: any,
    commandExplanation?: string,
    retryAttempt: number = 1,
    ctx: ExecContext = {}
  ): Promise<any> {
    const { signal, connectionClosed } = ctx;
    try {
      this.logger.info(`Executing command (attempt ${retryAttempt}/${this.MAX_RETRY_ATTEMPTS}): ${command}`);

      // Check if Pair Programming Mode is enabled
      const pairProgrammingEnabled = this.config.store.mcp?.pairProgrammingMode?.enabled === true;
      const showConfirmationDialog = pairProgrammingEnabled && this.config.store.mcp?.pairProgrammingMode?.showConfirmationDialog !== false;
      const autoFocusTerminal = pairProgrammingEnabled && this.config.store.mcp?.pairProgrammingMode?.autoFocusTerminal !== false;

      // Show confirmation dialog if enabled (only on first attempt)
      if (showConfirmationDialog && retryAttempt === 1) {
        try {
          const result = await this.dialogService.showConfirmCommandDialog(
            command,
            session.id,
            session.tab.title,
            commandExplanation
          );

          if (!result || !result.confirmed) {
            // Check if it was rejected with a message
            if (result && result.rejected && result.rejectMessage) {
              this.logger.info(`Command execution rejected by user: ${result.rejectMessage}`);
              return createJsonResponse({
                output: `Command execution rejected: ${result.rejectMessage}`,
                aborted: true,
                exitCode: null,
                userFeedback: {
                  accepted: false,
                  message: result.rejectMessage
                }
              });
            } else {
              // Regular cancellation
              this.logger.info('Command execution cancelled by user');
              return createJsonResponse({
                output: 'Command execution cancelled by user',
                aborted: true,
                exitCode: null
              });
            }
          }
        } catch (error) {
          this.logger.error('Error showing confirmation dialog:', error);
          // Continue with execution if dialog fails
        }
      }

      // Focus terminal if enabled (only on first attempt)
      if (autoFocusTerminal && retryAttempt === 1) {
        try {
          // First, select the tab to make it active
          this.app.selectTab(session.tabParent);

          // Wait for the tab to be selected and focused
          await new Promise(resolve => setTimeout(resolve, 300));

          // Try to focus the tab directly
          if (session.tab && typeof session.tab.focus === 'function') {
            session.tab.focus();
          }

          // Wait a bit more to ensure focus is complete
          await new Promise(resolve => setTimeout(resolve, 200));

          // Check if the tab is focused
          const isFocused = session.tab.hasFocus;
          if (!isFocused) {
            this.logger.warn('Terminal tab may not be properly focused, trying again');

            // Try one more time with a longer delay
            await new Promise(resolve => setTimeout(resolve, 500));

            if (session.tab && typeof session.tab.focus === 'function') {
              session.tab.focus();
            }

            // Final check
            if (!session.tab.hasFocus) {
              this.logger.warn('Terminal tab still not focused after retry');
            } else {
              this.logger.info('Terminal tab focused successfully after retry');
            }
          } else {
            this.logger.info('Terminal tab focused successfully');
          }
        } catch (error) {
          this.logger.error('Error focusing terminal:', error);
          // Continue with execution if focus fails
        }
      }

      // A closed session drops all input, so the end marker would never
      // appear and the wait loop below would spin forever.
      if (!this.execToolCategory.isSessionConnected(session)) {
        const autoReconnect = this.config.store.mcp?.autoReconnect === true;
        if (!autoReconnect) {
          return createErrorResponse(`Terminal session ${session.id} (${session.tab.title}) is disconnected. Reconnect the tab in Tabby, or enable "Auto reconnect" in the MCP settings.`);
        }
        const reconnected = await this.execToolCategory.reconnectSession(session, this.RECONNECT_TIMEOUT_MS);
        if (!reconnected) {
          return createErrorResponse(`Terminal session ${session.id} (${session.tab.title}) is disconnected and did not reconnect within ${this.RECONNECT_TIMEOUT_MS / 1000}s. Check the tab in Tabby (it may be waiting for a password).`);
        }
        // Give the remote shell a moment to print its prompt
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Cancelled while reconnecting or confirming: don't run it at all
      if (signal?.aborted || connectionClosed?.aborted) {
        return createErrorResponse('Cancelled before the command was sent; nothing ran.');
      }

      // Generate unique markers for this command. Keep the marker protocol
      // shell-agnostic: print a start marker, run the command, then print the
      // end marker with the exit code on the same line.
      const timestamp = Date.now();
      const marker = `_${timestamp}`;
      const startMarker = marker;
      const endMarker = marker;
      const executionStartTime = Date.now();

      // Track exit code
      let exitCode: number | null = null;
      let promptShell: string | null = null;

      // Create abort controller for this command
      let aborted = false;
      const abortHandler = () => {
        aborted = true;
        // Do not send Ctrl+C here, just mark as aborted
      };

      // Set active command
      this.execToolCategory.setActiveCommand({
        tabId: session.id,
        command,
        timestamp,
        startMarker,
        endMarker,
        abort: abortHandler,
        clientId: ctx.clientId
      });

      // Start tracking the command in running commands manager
      this.runningCommandsManager.startCommand(session.id.toString(), command);

      session.tab.sendInput('\x03');
      await new Promise(resolve => setTimeout(resolve, 100));

      const trimmedCommand = command.endsWith('\n') ? command.slice(0, -1) : command;
      // Keep the protocol simple, matching tmux-mcp: run a subshell and print
      // a single end marker with `$?`. No shell hooks, prompt hooks, temp
      // scripts, or cleanup variables. The end marker starts with a newline so
      // it gets its own line when the output does not end with one.
      const wrappedCommand = `(
printf '${marker}\\n'
${trimmedCommand}
printf '\\n${marker} %s\\n' "$?"
)\n`;

      session.tab.sendInput(wrappedCommand);

      // Wait for command output
      let output = '';
      let commandStarted = false;
      let commandFinished = false;
      let sessionClosed = false;
      let clientGone = false;
      let timedOut = false;
      const deadline = executionStartTime + (ctx.timeoutMs ?? this.DEFAULT_TIMEOUT_SEC * 1000);

      while (!commandFinished && !aborted) {
        await new Promise(resolve => setTimeout(resolve, 100)); // Poll every 100ms

        // Never wait forever, e.g. for a command waiting on input
        if (Date.now() > deadline) {
          timedOut = true;
          this.execToolCategory.abortCommand(session.id);
          break;
        }

        // The MCP client disconnected. Stop waiting but leave the command
        // running in the terminal; nobody asked to stop it.
        if (connectionClosed?.aborted) {
          clientGone = true;
          break;
        }

        // The MCP client cancelled the request (e.g. the user interrupted it)
        if (signal?.aborted) {
          this.execToolCategory.abortCommand(session.id);
          break;
        }

        if (!this.execToolCategory.isSessionConnected(session)) {
          sessionClosed = true;
          break;
        }

        // Get terminal buffer
        const textAfter = this.execToolCategory.getTerminalBufferText(session);

        // Clean ANSI codes and process output
        const cleanTextAfter = stripAnsi(textAfter);
        const lines = cleanTextAfter.split('\n');

        let promptIndex = -1;
        // Find the first standalone marker and the last marker carrying an exit
        // code. This mirrors the tmux-mcp/atux-style "same marker appears at
        // least twice" protocol without START/END labels.
        let startIndex = -1;
        let endIndex = -1;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line === marker) {
            startIndex = i;
            commandStarted = true;
            for (let j = startIndex - 1; j >= 0; j--) {
              if (lines[j].trim().length > 0) {
                promptIndex = j;
                break;
              }
            }
          }

          if (new RegExp(`^${marker}\\s+-?\\d+$`).test(line)) {
            endIndex = i;
            commandFinished = startIndex !== -1;
          }
        }

        // Extract output between markers
        if (commandStarted && commandFinished && startIndex !== -1 && endIndex !== -1) {
          const commandOutput = lines.slice(startIndex + 1, endIndex)
            .filter((line: string) => !line.includes(startMarker) && !line.includes(endMarker))
            .join('\n')
            .trim();

          if (promptIndex !== -1) {
            promptShell = lines[promptIndex].trim();
          }
          // Extract exit code from the final marker line (`<marker> <code>`).
          // Keep the old `exit_code:` parser as a fallback for older buffered output.
          const endLine = (lines[endIndex] || '').trim();
          const endMarkerMatch = endLine.match(new RegExp(`^${marker}\\s+(-?\\d+)$`));
          if (endMarkerMatch) {
            exitCode = parseInt(endMarkerMatch[1], 10);
          } else {
            for (let i = endIndex; i < Math.min(endIndex + 5, lines.length); i++) {
              if (lines[i].startsWith('exit_code:')) {
                exitCode = parseInt(lines[i].split(':')[1].trim(), 10);
                break;
              }
            }
          }

          output = commandOutput;
          break;
        }
      }

      if (aborted) {
        const note = timedOut
          ? `Timed out after ${Math.round((Date.now() - executionStartTime) / 1000)}s and was interrupted with Ctrl+C. Rerun with a larger timeout if it needs longer.`
          : undefined;
        return this.handleAbortedCommand(command, session, startMarker, executionStartTime, pairProgrammingEnabled, note);
      }

      if (clientGone) {
        this.logger.info(`MCP client disconnected, stopped waiting for: ${command}`);
        return createErrorResponse('MCP client disconnected');
      }

      // Do not retry: the command may already have run on the remote side
      if (sessionClosed) {
        this.logger.warn(`Session ${session.id} closed while running: ${command}`);
        return createErrorResponse(`Terminal session ${session.id} (${session.tab.title}) disconnected while the command was running. The command may or may not have completed; check get_terminal_buffer after reconnecting.`);
      }

      // Check if command execution failed and should retry
      if (!commandStarted || !commandFinished) {
        if (retryAttempt < this.MAX_RETRY_ATTEMPTS) {
          this.logger.warn(`Command execution failed (attempt ${retryAttempt}), retrying...`);
          // Clear active command before retry
          this.execToolCategory.clearActiveCommand(session.id);
          this.runningCommandsManager.endCommand(session.id.toString());
          
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Recursive retry
          return this.executeCommandWithRetry(command, session, commandExplanation, retryAttempt + 1, ctx);
        } else {
          throw new Error(`Command execution failed after ${this.MAX_RETRY_ATTEMPTS} attempts`);
        }
      }

      this.logger.info(`Command executed successfully: ${command}, tabIndex: ${session.id}, output length: ${output.length}`);

      return this.handleSuccessfulCommand(command, output, promptShell, exitCode, session, executionStartTime, pairProgrammingEnabled);

    } catch (error) {
      // Clear active command on error
      this.execToolCategory.clearActiveCommand(session.id);
      this.runningCommandsManager.endCommand(session.id.toString());
      
      if (retryAttempt < this.MAX_RETRY_ATTEMPTS) {
        this.logger.warn(`Command execution error (attempt ${retryAttempt}): ${error.message}, retrying...`);
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Recursive retry
        return this.executeCommandWithRetry(command, session, commandExplanation, retryAttempt + 1, ctx);
      } else {
        this.logger.error(`Command execution failed after ${this.MAX_RETRY_ATTEMPTS} attempts:`, error);
        throw error;
      }
    } finally {
      // Always clear active command when done (whether successful, aborted, or error)
      this.execToolCategory.clearActiveCommand(session.id);
      this.runningCommandsManager.endCommand(session.id.toString());
    }
  }

  /**
   * Handle aborted command logic
   */
  private async handleAbortedCommand(
    command: string,
    session: any,
    startMarker: string,
    executionStartTime: number,
    pairProgrammingEnabled: boolean,
    note?: string
  ): Promise<any> {
    this.logger.info(`Command was aborted, retrieving partial output`);

    const textAfter = this.execToolCategory.getTerminalBufferText(session);
    const cleanTextAfter = stripAnsi(textAfter);
    const lines = cleanTextAfter.split('\n');

    // Start after the marker the command printed, not the shell's echo of the
    // command lines (same as a finished command)
    const startIndex = lines.findIndex((line: string) => line.trim() === startMarker);

    let output = '';
    if (startIndex !== -1) {
      output = lines.slice(startIndex + 1)
        .filter((line: string) => !line.includes(startMarker))
        .join('\n')
        .trim();
    } else {
      // Not started yet: return nothing rather than earlier commands' output
      note = [note, 'The command had not started printing yet, so there is no output.'].filter(Boolean).join(' ');
    }

    // Store the output in the storage service
    const outputId = this.outputStorage.storeOutput({
      command,
      output,
      promptShell: null,
      exitCode: null,
      timestamp: Date.now(),
      aborted: true,
      tabId: session.id
    });

    // Add to command history
    const executionEndTime = Date.now();
    this.commandHistoryManager.addCommand({
      command,
      output,
      promptShell: null,
      exitCode: null,
      timestamp: executionStartTime,
      aborted: true,
      tabId: session.id.toString(),
      tabTitle: session.tab.title,
      duration: executionEndTime - executionStartTime
    });

    const outputLines = output.split('\n');
    if (outputLines.length > this.MAX_LINES_PER_RESPONSE) {
      output = outputLines.slice(0, this.MAX_LINES_PER_RESPONSE).join('\n') + '\n...';
    }

    // Show result dialog if enabled
    const showResultDialog = pairProgrammingEnabled && this.config.store.mcp?.pairProgrammingMode?.showResultDialog !== false;
    if (showResultDialog) {
      try {
        const result = await this.dialogService.showCommandResultDialog(
          command,
          output,
          null,
          true // aborted
        );

        if (result) {
          if (result.accepted && result.userMessage) {
            return createJsonResponse({
              output: output,
              promptShell: null,
              exitCode: null,
              aborted: true,
              outputId,
              message: result.userMessage,
              userFeedback: {
                accepted: true,
                message: result.userMessage
              }
            });
          } else if (result.accepted === false && result.rejectionMessage) {
            return createJsonResponse({
              output: output,
              promptShell: null,
              exitCode: null,
              aborted: true,
              outputId,
              message: `Command rejected: ${result.rejectionMessage}`,
              userFeedback: {
                accepted: false,
                message: result.rejectionMessage
              }
            });
          }
        }
      } catch (error) {
        this.logger.error('Error showing result dialog:', error);
      }
    }

    return createJsonResponse({
      output: output,
      promptShell: null,
      exitCode: null,
      aborted: true,
      outputId,
      message: [
        note,
        outputLines.length > this.MAX_LINES_PER_RESPONSE
          ? `Output is too long (${outputLines.length} lines). Full output stored with ID: ${outputId}. Use get_command_output tool with this ID to retrieve the full output.`
          : '',
      ].filter(Boolean).join(' '),
    });
  }

  /**
   * Handle successful command execution
   */
  private async handleSuccessfulCommand(
    command: string,
    output: string,
    promptShell: string | null,
    exitCode: number | null,
    session: any,
    executionStartTime: number,
    pairProgrammingEnabled: boolean
  ): Promise<any> {
    // Store the output in the storage service
    const outputId = this.outputStorage.storeOutput({
      command,
      output,
      promptShell,
      exitCode,
      timestamp: Date.now(),
      aborted: false,
      tabId: session.id
    });

    // Add to command history
    const executionEndTime = Date.now();
    this.commandHistoryManager.addCommand({
      command,
      output,
      promptShell,
      exitCode,
      timestamp: executionStartTime,
      aborted: false,
      tabId: session.id.toString(),
      tabTitle: session.tab.title,
      duration: executionEndTime - executionStartTime
    });

    const outputLines = output.split('\n');
    if (outputLines.length > this.MAX_LINES_PER_RESPONSE) {
      output = outputLines.slice(0, this.MAX_LINES_PER_RESPONSE).join('\n') + '\n...';
    }

    // Show result dialog if enabled
    const showResultDialog = pairProgrammingEnabled && this.config.store.mcp?.pairProgrammingMode?.showResultDialog !== false;
    if (showResultDialog) {
      try {
        const result = await this.dialogService.showCommandResultDialog(
          command,
          output,
          exitCode,
          false // not aborted
        );

        if (result) {
          if (result.accepted && result.userMessage) {
            return createJsonResponse({
              output: output,
              promptShell,
              exitCode,
              aborted: false,
              outputId,
              message: result.userMessage,
              userFeedback: {
                accepted: true,
                message: result.userMessage
              }
            });
          } else if (result.accepted === false && result.rejectionMessage) {
            return createJsonResponse({
              output: output,
              promptShell,
              exitCode,
              aborted: false,
              outputId,
              message: `Command rejected: ${result.rejectionMessage}`,
              userFeedback: {
                accepted: false,
                message: result.rejectionMessage
              }
            });
          }
        }
      } catch (error) {
        this.logger.error('Error showing result dialog:', error);
      }
    }

    return createJsonResponse({
      output: output,
      promptShell,
      exitCode,
      aborted: false,
      outputId,
      message: outputLines.length > this.MAX_LINES_PER_RESPONSE
        ? `Output is too long (${outputLines.length} lines). Full output stored with ID: ${outputId}. Use get_command_output tool with this ID to retrieve the full output.`
        : '',
    });
  }

  getTool() {
    return {
      name: 'exec_command',
      description: `Run a shell command in a Tabby terminal tab and return its output, exit code and prompt.
- One command per tab. A command from another client waits up to 30s, then returns a busy error: retry, use another tab, or open_tab.
- Interrupted with Ctrl+C after \`timeout\` seconds (default 600).
- Output over 250 lines is truncated; get the rest with get_command_output and the returned outputId.
- A disconnected tab is reconnected first when Auto Reconnect is on; otherwise an error is returned.`,
      schema: {
        command: z.string().describe('Shell command to run'),

        commandExplanation: z.string().optional().describe('What the command does, shown to the user in pair programming mode'),

        tabId: z.string().optional().describe('Tab id from get_ssh_session_list (default: focused tab)'),

        expectTitle: z.string().optional().describe('Text the tab title must contain, so a wrong tab is refused. Without tabId, the first matching tab is used'),

        timeout: z.number().int().min(1).optional().describe('Seconds before the command is interrupted with Ctrl+C (default 600)')
      },
      handler: async (params, extra) => {
        let session; // Declare session at outer scope for catch/finally access
        
        try {
          console.log('Params:', JSON.stringify(params));
          const { command, tabId, expectTitle, commandExplanation } = params;
          console.log(`Executing command: ${command}, tabId: ${tabId}`);
          if (commandExplanation) {
            console.log(`Command explanation: ${commandExplanation}`);
          }

          const resolved = this.execToolCategory.resolveSession(tabId, expectTitle);
          if (resolved.error) {
            return createErrorResponse(resolved.error);
          }
          session = resolved.session;

          this.logger.info(`Using terminal session ${session.id} (${session.tab.title})`);

          const ctx: ExecContext = {
            signal: extra?.signal,
            connectionClosed: extra?.connectionClosed,
            clientId: extra?.sessionId,
            timeoutMs: params.timeout ? params.timeout * 1000 : undefined,
          };

          // A new command from the same client replaces its previous one
          // (e.g. one it gave up on); another client's command is never aborted.
          const running = this.execToolCategory.getActiveCommand(session.id);
          if (running && running.clientId === ctx.clientId) {
            this.logger.info(`Auto-aborting previous command in session ${session.id}: ${running.command}`);
            this.execToolCategory.abortCommand(session.id);
          }

          // One command per tab: wait for another client's command to finish
          const release = await this.execToolCategory.acquireTab(session, this.TAB_WAIT_MS, [ctx.signal, ctx.connectionClosed]);
          if (!release) {
            if (ctx.signal?.aborted || ctx.connectionClosed?.aborted) {
              return createErrorResponse('Cancelled while waiting for the tab');
            }
            const busy = this.execToolCategory.getActiveCommand(session.id);
            const detail = busy
              ? ` running "${busy.command.slice(0, 80)}" for ${Math.round((Date.now() - busy.timestamp) / 1000)}s`
              : '';
            return createErrorResponse(`Tab ${session.id} (${session.tab.title}) is busy${detail} for another client. Retry later, use another tab, or open_tab.`);
          }

          try {
            return await this.executeCommandWithRetry(command, session, commandExplanation, 1, ctx);
          } finally {
            release();
          }

        } catch (err) {
          this.logger.error(`Error executing command:`, err);
          return createErrorResponse(`Failed to execute command: ${err.message || err}`);
        }
      }
    };
  }
}
