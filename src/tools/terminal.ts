import { Injectable } from '@angular/core';
import { AppService, BaseTabComponent, ConfigService, HostWindowService, PartialProfile, Profile, ProfilesService, SplitTabComponent } from 'tabby-core';
import { BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal';
import { BaseToolCategory } from './base-tool-category';
import { SerializeAddon } from '@xterm/addon-serialize';
import { BehaviorSubject } from 'rxjs';
import { map } from 'rxjs/operators';
import { ShellContext } from './shell-strategy';
import { McpLoggerService } from '../services/mcpLogger.service';
import { CommandOutputStorageService } from '../services/commandOutputStorage.service';
import { CommandHistoryManagerService } from '../services/commandHistoryManager.service';
import { DialogService } from '../services/dialog.service';
import { RunningCommandsManagerService } from '../services/runningCommandsManager.service';
import {
  SshSessionListTool,
  ExecCommandTool,
  GetTerminalBufferTool,
  GetCommandOutputTool,
  ListProfilesTool,
  OpenTabTool,
  CloseTabTool
} from './terminal/';

/**
 * Interface for terminal tab component with ID
 */
export interface BaseTerminalTabComponentWithId {
  id: number;
  tabParent: BaseTabComponent;
  tab: BaseTerminalTabComponent<any>;
}

/**
 * Interface for tracking active command
 */
export interface ActiveCommand {
  tabId: number;
  command: string;
  timestamp: number;
  startMarker: string;
  endMarker: string;
  abort: () => void;
  // MCP session that started the command
  clientId?: string;
}

/**
 * A tab found for a tool call, or why none was found
 */
export type SessionLookup =
  | { session: BaseTerminalTabComponentWithId, error?: undefined }
  | { session?: undefined, error: string };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Resolve true when `promise` settles, false on timeout or when any signal aborts.
 */
function waitFor(promise: Promise<unknown>, ms: number, signals: (AbortSignal | undefined)[]): Promise<boolean> {
  return new Promise(resolve => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      signals.forEach(s => s?.removeEventListener('abort', onAbort));
      resolve(ok);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(false), ms);
    signals.forEach(s => s?.addEventListener('abort', onAbort));
    if (signals.some(s => s?.aborted)) {
      done(false);
      return;
    }
    promise.then(() => done(true), () => done(true));
  });
}

/**
 * Terminal execution tool category
 * Provides tools for terminal commands execution and SSH session management
 */
@Injectable({ providedIn: 'root' })
export class ExecToolCategory extends BaseToolCategory {
  name: string = 'exec';

  // Track active commands per session (sessionId -> ActiveCommand)
  private _activeCommands = new Map<number, ActiveCommand>();
  private _activeCommandsSubject = new BehaviorSubject<Map<number, ActiveCommand>>(new Map());

  // Observable for UI to subscribe to
  public readonly activeCommands$ = this._activeCommandsSubject.asObservable();
  
  // Legacy observable for backward compatibility (returns any active command)
  public readonly activeCommand$ = this._activeCommandsSubject.asObservable().pipe(
    map(commands => commands.size > 0 ? Array.from(commands.values())[0] : null)
  );

  // Shell context for managing different shell types
  public shellContext = new ShellContext();

  // Per-tab command queue (tab -> tail of the queue), so two clients never
  // type into the same shell at once
  private tabQueues = new WeakMap<object, Promise<void>>();
  // Reconnects in progress, shared by every caller on the same tab
  private reconnects = new WeakMap<object, Promise<boolean>>();

  // Stable tab ids: a tab keeps its id while open, so ids don't shift when
  // other tabs open or close. Ids are never reused.
  private tabIds = new WeakMap<object, number>();
  private nextTabId = 0;

  // Tabs opened with open_tab (tab -> MCP session id that opened it)
  private agentTabs = new Map<BaseTerminalTabComponent<any>, string | undefined>();

  constructor(
    private app: AppService,
    logger: McpLoggerService,
    private config: ConfigService,
    private dialogService: DialogService,
    private commandHistoryManager: CommandHistoryManagerService,
    private runningCommandsManager: RunningCommandsManagerService,
    private profilesService: ProfilesService
  ) {
    super(logger);

    // Log discovered terminal sessions for debugging
    this.findAndSerializeTerminalSessions().forEach(session => {
      this.logger.debug(`Found session: ${session.id}, ${session.tab.title}`);
    });

    // Initialize and register all tools
    this.initializeTools();
  }

  /**
   * Initialize and register all tools
   */
  private initializeTools(): void {
    // Create shared storage service for command outputs
    const commandOutputStorage = new CommandOutputStorageService(this.logger);

    // Create tool instances
    const sshSessionListTool = new SshSessionListTool(this, this.logger);
    const execCommandTool = new ExecCommandTool(
      this,
      this.logger,
      this.config,
      this.dialogService,
      this.app,
      this.runningCommandsManager,
      commandOutputStorage,
      this.commandHistoryManager
    );
    const getTerminalBufferTool = new GetTerminalBufferTool(this, this.logger);
    const getCommandOutputTool = new GetCommandOutputTool(this.logger, commandOutputStorage);

    // Register tools
    this.registerTool(sshSessionListTool.getTool());
    this.registerTool(execCommandTool.getTool());
    this.registerTool(getTerminalBufferTool.getTool());
    this.registerTool(getCommandOutputTool.getTool());
    this.registerTool(new ListProfilesTool(this, this.logger).getTool());
    this.registerTool(new OpenTabTool(this, this.logger).getTool());
    this.registerTool(new CloseTabTool(this, this.logger).getTool());
  }

  /**
   * Get current active command (legacy - returns first active command)
   */
  public get activeCommand(): ActiveCommand | null {
    return this._activeCommands.size > 0 ? Array.from(this._activeCommands.values())[0] : null;
  }

  /**
   * Get active command for specific session
   */
  public getActiveCommand(sessionId: number): ActiveCommand | null {
    return this._activeCommands.get(sessionId) || null;
  }

  /**
   * Set active command for a session and notify subscribers
   */
  public setActiveCommand(command: ActiveCommand | null): void {
    if (command) {
      this._activeCommands.set(command.tabId, command);
      this.logger.debug(`Active command set for session ${command.tabId}: ${command.command}`);
    } else {
      // Legacy behavior - if command is null, clear the first active command
      if (this._activeCommands.size > 0) {
        const firstSessionId = Array.from(this._activeCommands.keys())[0];
        this._activeCommands.delete(firstSessionId);
        this.logger.debug(`Active command cleared for session ${firstSessionId}`);
      }
    }
    this._activeCommandsSubject.next(new Map(this._activeCommands));
  }

  /**
   * Clear active command for specific session
   */
  public clearActiveCommand(sessionId: number): void {
    if (this._activeCommands.has(sessionId)) {
      this._activeCommands.delete(sessionId);
      this._activeCommandsSubject.next(new Map(this._activeCommands));
      this.logger.debug(`Active command cleared for session ${sessionId}`);
    }
  }

  /**
   * Abort command for specific session
   */
  public abortCommand(sessionId: number): void {
    const activeCommand = this._activeCommands.get(sessionId);
    if (activeCommand) {
      // Find the terminal session for this command
      const sessions = this.findAndSerializeTerminalSessions();
      const session = sessions.find(s => s.id === sessionId);
      
      if (session) {
        // Send Ctrl+C to interrupt the command
        this.logger.debug(`Sending Ctrl+C to abort command in session ${sessionId}: ${activeCommand.command}`);
        session.tab.sendInput('\x03'); // Ctrl+C
      }
      
      // Call the abort handler which sets the aborted flag
      activeCommand.abort();
      
      // Remove from active commands
      this._activeCommands.delete(sessionId);
      this._activeCommandsSubject.next(new Map(this._activeCommands));
      this.logger.debug(`Command aborted for session ${sessionId}`);
    }
  }

  /**
   * Abort the current command if any (legacy method)
   */
  public abortCurrentCommand(): void {
    if (this._activeCommands.size > 0) {
      const firstSessionId = Array.from(this._activeCommands.keys())[0];
      this.abortCommand(firstSessionId);
    }
  }

  /**
   * Find all terminal sessions and map them to a serializable format
   * @returns Array of terminal sessions with IDs
   */
  public findAndSerializeTerminalSessions(): BaseTerminalTabComponentWithId[] {
    const sessions: BaseTerminalTabComponentWithId[] = [];
    this.app.tabs.forEach((tab, tabIdx) => {
      if (tab instanceof BaseTerminalTabComponent) {
        sessions.push({
          id: this.idFor(tab),
          tabParent: tab,
          tab: tab as BaseTerminalTabComponent<any>
        });
      } else if (tab instanceof SplitTabComponent) {
        sessions.push(...tab.getAllTabs()
          .filter(childTab => childTab instanceof BaseTerminalTabComponent && (childTab as BaseTerminalTabComponent<any>).frontend !== undefined)
          .map(childTab => ({
            id: this.idFor(childTab),
            tabParent: tab,
            tab: childTab as BaseTerminalTabComponent<any>
          })));
      }
    });
    return sessions;
  }

  /**
   * Whether the tab is the one the user is looking at. tab.hasFocus can stay
   * true after another tab is selected, so also check the active tab (and the
   * focused pane of a split tab).
   */
  public isFocused(session: BaseTerminalTabComponentWithId): boolean {
    const parent = session.tabParent;
    if (this.app.activeTab !== parent) {
      return false;
    }
    return parent instanceof SplitTabComponent ? parent.getFocusedTab() === session.tab : true;
  }

  private idFor(tab: BaseTabComponent): number {
    let id = this.tabIds.get(tab);
    if (id === undefined) {
      id = this.nextTabId++;
      this.tabIds.set(tab, id);
    }
    return id;
  }

  /**
   * Find the tab for a tool call. With expectTitle, refuse a tab whose title
   * doesn't contain it, so a stale id never runs on the wrong server.
   * Without tabId, use the first tab matching expectTitle, else the focused tab.
   */
  public resolveSession(tabId?: string, expectTitle?: string): SessionLookup {
    const sessions = this.findAndSerializeTerminalSessions();
    const titleOf = (s: BaseTerminalTabComponentWithId) => s.tab.customTitle || s.tab.title;
    const matches = (s: BaseTerminalTabComponentWithId) =>
      !expectTitle || [s.tab.customTitle, s.tab.title].some(t => t?.includes(expectTitle));

    let session: BaseTerminalTabComponentWithId | undefined;
    if (tabId) {
      session = sessions.find(s => s.id.toString() === tabId);
      if (!session) {
        return { error: `No terminal session found with ID ${tabId}` };
      }
      if (!matches(session)) {
        return { error: `Tab ${tabId} is "${titleOf(session)}", not "${expectTitle}". Call get_ssh_session_list for current ids.` };
      }
    } else if (expectTitle) {
      session = sessions.find(matches);
      if (!session) {
        return { error: `No tab title contains "${expectTitle}"` };
      }
    } else {
      session = sessions.find(s => this.isFocused(s)) || sessions[0];
      if (!session) {
        return { error: 'No terminal sessions available' };
      }
    }
    return { session };
  }

  /**
   * Profile group path, e.g. "Adobe Campaign PROD / PROD Asia", so a client
   * can tell environments apart without relying on tab names.
   */
  public groupPath(groupId?: string): string | undefined {
    const groups: { id: string, name: string, parentGroupId?: string }[] = this.config.store.groups || [];
    const names: string[] = [];
    const seen = new Set<string>();
    let group = groups.find(g => g.id === groupId);
    while (group && !seen.has(group.id)) {
      seen.add(group.id);
      names.unshift(group.name);
      const parentId = group.parentGroupId;
      group = groups.find(g => g.id === parentId);
    }
    return names.length ? names.join(' / ') : undefined;
  }

  /**
   * Group path of the profile a tab was opened from (SSH, Telnet, Serial)
   */
  public tabGroup(session: BaseTerminalTabComponentWithId): string | undefined {
    return this.groupPath((session.tab as any).profile?.group);
  }

  public isAgentTab(session: BaseTerminalTabComponentWithId): boolean {
    return this.agentTabs.has(session.tab);
  }

  /**
   * Profiles agents may open (Settings -> MCP -> Agent Tabs)
   */
  public async getAllowedProfiles(): Promise<PartialProfile<Profile>[]> {
    const allowed: string[] = this.config.store.mcp?.openTab?.profiles || [];
    if (!allowed.length) {
      return [];
    }
    const profiles = await this.profilesService.getProfiles({ includeBuiltin: false });
    return profiles.filter(p => !p.isTemplate && allowed.includes(p.name));
  }

  /**
   * Open a tab for a saved profile and wait until its session is open.
   */
  public async openAgentTab(
    profileName: string,
    title: string | undefined,
    clientId: string | undefined,
    timeoutMs: number
  ): Promise<SessionLookup> {
    const profiles = await this.getAllowedProfiles();
    const profile = profiles.find(p => p.name === profileName);
    if (!profile) {
      const names = profiles.map(p => p.name);
      return { error: names.length
        ? `Profile "${profileName}" is not allowed. Allowed: ${names.join(', ')}`
        : 'No profiles are allowed. Add them in Tabby Settings -> MCP -> Agent Tabs.' };
    }

    const limit = this.config.store.mcp?.openTab?.maxPerClient ?? 2;
    const owned = [...this.agentTabs.values()].filter(owner => owner === clientId).length;
    if (owned >= limit) {
      return { error: `This client already has ${owned} open tab(s) (limit ${limit}). Close one with close_tab first.` };
    }

    // Opening a tab selects it, sometimes only after openNewTabForProfile()
    // resolves; give focus back so the user isn't interrupted
    const previous = this.app.activeTab;
    const restoreFocus = () => {
      if (previous && this.app.tabs.includes(previous) && this.app.activeTab !== previous) {
        this.app.selectTab(previous);
      }
    };
    const tab = await this.profilesService.openNewTabForProfile(profile) as BaseTerminalTabComponent<any>;
    restoreFocus();
    if (!tab) {
      return { error: `Could not open a tab for profile "${profileName}"` };
    }
    tab.customTitle = `[AI] ${title || profileName}`;
    this.agentTabs.set(tab, clientId);
    // Forget it when the tab closes, however it is closed
    tab.destroyed$.subscribe(() => this.agentTabs.delete(tab));
    this.logger.info(`Opened agent tab "${tab.customTitle}" for client ${clientId}`);

    // The tab only shows up once its frontend is ready
    const deadline = Date.now() + timeoutMs;
    let session: BaseTerminalTabComponentWithId | undefined;
    while (Date.now() < deadline) {
      session = this.findAndSerializeTerminalSessions().find(s => s.tab === tab);
      if (session && this.isSessionConnected(session)) {
        restoreFocus();
        return { session };
      }
      await sleep(200);
    }
    restoreFocus();
    return { error: `Tab${session ? ` ${session.id}` : ''} opened but did not connect within ${timeoutMs / 1000}s. Check it in Tabby (it may be waiting for a password).` };
  }

  /**
   * Close a tab opened with open_tab.
   */
  public async closeAgentTab(session: BaseTerminalTabComponentWithId, clientId: string | undefined): Promise<string | null> {
    if (!this.agentTabs.has(session.tab)) {
      return `Tab ${session.id} was not opened with open_tab; only those can be closed.`;
    }
    const running = this.getActiveCommand(session.id);
    if (running && running.clientId !== clientId) {
      return `Tab ${session.id} is running another client's command.`;
    }
    if (running) {
      this.abortCommand(session.id);
    }
    await this.closeTab(session);
    return null;
  }

  /**
   * Close idle tabs a client opened, once its connection is gone.
   */
  public async closeClientTabs(clientId: string): Promise<void> {
    if (this.config.store.mcp?.openTab?.closeOnDisconnect === false) {
      return;
    }
    for (const session of this.findAndSerializeTerminalSessions()) {
      if (this.agentTabs.has(session.tab) && this.agentTabs.get(session.tab) === clientId && !this.getActiveCommand(session.id)) {
        this.logger.info(`Closing agent tab ${session.id} of disconnected client ${clientId}`);
        await this.closeTab(session);
      }
    }
  }

  private async closeTab(session: BaseTerminalTabComponentWithId): Promise<void> {
    const parent = session.tabParent;
    if (parent instanceof SplitTabComponent && parent.getAllTabs().length > 1) {
      // Only close our pane if the user split the tab
      session.tab.destroy();
    } else {
      await this.app.closeTab(parent, false);
    }
  }

  /**
   * Whether the tab still has a live session that can receive input.
   * After an SSH session is closed, Tabby sets `tab.session` to null and
   * `sendInput()` silently drops everything.
   */
  public isSessionConnected(session: BaseTerminalTabComponentWithId): boolean {
    return !!session.tab.session?.open;
  }

  /**
   * Whether Tabby is already connecting the tab: the spinner runs during the
   * SSH handshake, and the new session is set but not open while the shell starts.
   */
  private isConnecting(session: BaseTerminalTabComponentWithId): boolean {
    const tab = session.tab as any;
    return !!tab.spinnerActive || (!!tab.session && !tab.session.open);
  }

  /**
   * Reconnect a disconnected connectable tab (SSH, Telnet, Serial) and wait
   * until its session is open again. Callers on the same tab share one attempt.
   * @returns true if the session is open after reconnecting
   */
  public reconnectSession(session: BaseTerminalTabComponentWithId, timeoutMs: number): Promise<boolean> {
    const key = session.tab;
    let pending = this.reconnects.get(key);
    if (!pending) {
      pending = this.doReconnect(session, timeoutMs).finally(() => this.reconnects.delete(key));
      this.reconnects.set(key, pending);
    }
    return pending;
  }

  private async doReconnect(session: BaseTerminalTabComponentWithId, timeoutMs: number): Promise<boolean> {
    const tab = session.tab as any;
    const deadline = Date.now() + timeoutMs;

    // reconnect() destroys the current session first, so calling it while
    // Tabby is connecting (e.g. the user pressed a key) would restart that attempt
    if (this.isConnecting(session)) {
      this.logger.info(`Session ${session.id} (${session.tab.title}) is already connecting, waiting`);
    } else {
      if (typeof tab.reconnect !== 'function') {
        return false;
      }
      this.logger.info(`Reconnecting session ${session.id} (${session.tab.title})`);
      // reconnect() resolves once the connection attempt finishes, but it can
      // also wait on user input (e.g. a password prompt), so cap the wait.
      const reconnect = Promise.resolve(tab.reconnect()).catch(err => {
        this.logger.error(`Reconnect failed for session ${session.id}:`, err);
      });
      await Promise.race([reconnect, sleep(timeoutMs)]);
    }

    while (!this.isSessionConnected(session) && Date.now() < deadline) {
      await sleep(200);
    }
    return this.isSessionConnected(session);
  }

  /**
   * Wait for the tab to be free and take it.
   * @returns a release function, or null on timeout or cancel
   */
  public async acquireTab(
    session: BaseTerminalTabComponentWithId,
    waitMs: number,
    signals: (AbortSignal | undefined)[]
  ): Promise<(() => void) | null> {
    const key = session.tab;
    const previous = this.tabQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => (release = resolve));
    // Later callers wait for both the previous holder and us
    this.tabQueues.set(key, previous.then(() => mine));

    if (await waitFor(previous, waitMs, signals)) {
      return release;
    }
    // Gave up: let the queue move on as soon as the previous holder is done
    release();
    return null;
  }

  /**
   * Get terminal buffer content as text
   * @param session The terminal session
   * @returns The terminal buffer content as text
   */
  public getTerminalBufferText(session: BaseTerminalTabComponentWithId): string {
    try {
      const frontend = session.tab.frontend as XTermFrontend;
      if (!frontend || !frontend.xterm) {
        this.logger.error(`No xterm frontend available for session ${session.id}`);
        return '';
      }

      // Check if serialize addon is already registered
      let serializeAddon = (frontend.xterm as any)._addonManager._addons.find(
        addon => addon.instance instanceof SerializeAddon
      )?.instance;

      // If not, register it
      if (!serializeAddon) {
        serializeAddon = new SerializeAddon();
        frontend.xterm.loadAddon(serializeAddon);
      }

      // Get the terminal content
      return serializeAddon.serialize();
    } catch (err) {
      this.logger.error(`Error getting terminal buffer:`, err);
      return '';
    }
  }
}