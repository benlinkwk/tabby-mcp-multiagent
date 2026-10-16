import { createJsonResponse } from '../../type/types';
import { BaseTool } from './base-tool';
import { ExecToolCategory } from '../terminal';
import { McpLoggerService } from '../../services/mcpLogger.service';

/**
 * Tool for getting a list of all terminal sessions (SSH and local)
 *
 * This tool returns information about all available terminal sessions
 * that can be used with other terminal tools.
 */
export class SshSessionListTool extends BaseTool {
  constructor(private execToolCategory: ExecToolCategory, logger: McpLoggerService) {
    super(logger);
  }

  getTool() {
    return {
      name: 'get_ssh_session_list',
      description: `List Tabby terminal tabs with id, title, focus and whether the session is connected. A tab keeps its id while open. group is the profile group path (tells PROD from UAT); agentTab marks tabs opened with open_tab.`,
      schema: {},
      handler: async (_, extra) => {
        const serializedSessions = this.execToolCategory.findAndSerializeTerminalSessions().map(session => ({
          id: session.id,
          title: session.tab.title,
          customTitle: session.tab.customTitle,
          hasActivity: session.tab.hasActivity,
          hasFocus: this.execToolCategory.isFocused(session),
          connected: this.execToolCategory.isSessionConnected(session),
          group: this.execToolCategory.tabGroup(session),
          ...(this.execToolCategory.isAgentTab(session) ? { agentTab: true } : {}),
        }));

        return createJsonResponse(serializedSessions);
      }
    };
  }
}
