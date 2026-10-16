import * as z from 'zod';
import { createErrorResponse, createJsonResponse } from '../../type/types';
import { BaseTool } from './base-tool';
import { ExecToolCategory } from '../terminal';
import { McpLoggerService } from '../../services/mcpLogger.service';

/**
 * Tool for closing a tab opened with open_tab
 *
 * Tabs the user opened can never be closed this way.
 */
export class CloseTabTool extends BaseTool {
  constructor(private execToolCategory: ExecToolCategory, logger: McpLoggerService) {
    super(logger);
  }

  getTool() {
    return {
      name: 'close_tab',
      description: 'Close a tab opened with open_tab when you are done with it.',
      schema: {
        tabId: z.string().describe('Tab id returned by open_tab')
      },
      handler: async (params, extra) => {
        try {
          const { session, error } = this.execToolCategory.resolveSession(params.tabId);
          if (!session) {
            return createErrorResponse(error);
          }
          const closeError = await this.execToolCategory.closeAgentTab(session, extra?.sessionId);
          if (closeError) {
            return createErrorResponse(closeError);
          }
          return createJsonResponse({ closed: session.id });
        } catch (err) {
          this.logger.error(`Error closing tab:`, err);
          return createErrorResponse(`Failed to close tab: ${err.message || err}`);
        }
      }
    };
  }
}
