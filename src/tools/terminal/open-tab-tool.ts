import * as z from 'zod';
import { createErrorResponse, createJsonResponse } from '../../type/types';
import { BaseTool } from './base-tool';
import { ExecToolCategory } from '../terminal';
import { McpLoggerService } from '../../services/mcpLogger.service';

/**
 * Tool for opening a new tab from a saved profile
 *
 * Lets each agent work in its own shell instead of sharing a tab.
 */
export class OpenTabTool extends BaseTool {
  // How long to wait for the new tab to connect
  private readonly CONNECT_TIMEOUT_MS = 30000;

  constructor(private execToolCategory: ExecToolCategory, logger: McpLoggerService) {
    super(logger);
  }

  getTool() {
    return {
      name: 'open_tab',
      description: `Open a new tab from a saved profile (see list_profiles) and wait until it connects. Use it when the tab you need is busy, so each agent has its own shell. Returns the new tab id; the tab is titled "[AI] <title>" and closed when this client disconnects.`,
      schema: {
        profile: z.string().describe('Profile name from list_profiles'),
        title: z.string().optional().describe('Short tab title (default: profile name)')
      },
      handler: async (params, extra) => {
        try {
          const { session, error } = await this.execToolCategory.openAgentTab(
            params.profile, params.title, extra?.sessionId, this.CONNECT_TIMEOUT_MS
          );
          if (!session) {
            return createErrorResponse(error);
          }
          return createJsonResponse({ id: session.id, title: session.tab.customTitle });
        } catch (err) {
          this.logger.error(`Error opening tab:`, err);
          return createErrorResponse(`Failed to open tab: ${err.message || err}`);
        }
      }
    };
  }
}
