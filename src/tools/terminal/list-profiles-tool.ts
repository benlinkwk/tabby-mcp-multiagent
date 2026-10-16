import { createJsonResponse } from '../../type/types';
import { BaseTool } from './base-tool';
import { ExecToolCategory } from '../terminal';
import { McpLoggerService } from '../../services/mcpLogger.service';

/**
 * Tool for listing the saved profiles that open_tab may open
 *
 * Only names and types are returned, never hosts or credentials.
 */
export class ListProfilesTool extends BaseTool {
  constructor(private execToolCategory: ExecToolCategory, logger: McpLoggerService) {
    super(logger);
  }

  getTool() {
    return {
      name: 'list_profiles',
      description: 'List the saved Tabby profiles that open_tab may open, with their group path (e.g. PROD or UAT).',
      schema: {},
      handler: async () => {
        const profiles = await this.execToolCategory.getAllowedProfiles();
        return createJsonResponse(profiles.map(p => {
          const group = this.execToolCategory.groupPath(p.group);
          return { name: p.name, type: p.type, ...(group ? { group } : {}) };
        }));
      }
    };
  }
}
