import { Component, HostBinding, OnInit } from '@angular/core';
import { ConfigService, ProfilesService } from 'tabby-core';
import { McpService } from '../services/mcpService';
import { McpLoggerService } from '../services/mcpLogger.service';
import { ExecToolCategory } from '../tools/terminal';

/**
 * A saved profile as shown in the Agent Tabs list
 */
interface AgentTabProfile {
    id?: string;
    name: string;
    icon?: string;
    color?: string;
    // e.g. the SSH host
    description: string;
}

/** @hidden */
@Component({
    templateUrl: './mcpSettingsTab.component.pug',
})
export class McpSettingsTabComponent implements OnInit {
    @HostBinding('class.content-box') true
    isServerRunning = false;
    serverUrl: string = 'http://localhost:3001';
    port: number = 3001;
    listenHost: string = '127.0.0.1';
    enableDebugLogging: boolean = false;
    startOnBoot: boolean = true;
    autoReconnect: boolean = false;
    // Saved profiles by group path, and the names agents may open with open_tab
    profileGroups: { path: string, profiles: AgentTabProfile[] }[] = [];
    agentTabProfiles: string[] = [];
    closeAgentTabsOnDisconnect: boolean = true;

    // Pair Programming Mode settings
    pairProgrammingEnabled: boolean = false;
    autoFocusTerminal: boolean = true;
    showConfirmationDialog: boolean = true;
    showResultDialog: boolean = true;

    constructor(
        public config: ConfigService,
        private mcpService: McpService,
        private logger: McpLoggerService,
        private profilesService: ProfilesService,
        private execToolCategory: ExecToolCategory
    ) {
        console.log('McpSettingsTabComponent constructor');
    }

    ngOnInit(): void {
        console.log('McpSettingsTabComponent initialized');
        // Initialize config
        this.initializeConfig();

        // Load values from config
        this.loadConfigValues();

        // Check server status
        this.updateServerStatus();

        this.loadProfiles();

        // Log initial state
        console.log('MCP Settings initial state:', {
            serverUrl: this.serverUrl,
            port: this.port,
            debugLogging: this.enableDebugLogging,
            startOnBoot: this.startOnBoot,
            configStore: this.config.store.mcp
        });
    }

    private initializeConfig(): void {
        console.log('Initializing MCP config');
        try {
            if (!this.config.store.mcp) {
                console.log('Creating default MCP config section');
                this.config.store.mcp = {
                    startOnBoot: true,
                    enabled: true,
                    port: 3001,
                    listenHost: '127.0.0.1',
                    serverUrl: 'http://localhost:3001',
                    enableDebugLogging: false,
                    pairProgrammingMode: {
                        enabled: false,
                        autoFocusTerminal: true,
                        showConfirmationDialog: true,
                        showResultDialog: true
                    }
                };
                this.config.save();
            } else if (!this.config.store.mcp.pairProgrammingMode) {
                // Initialize Pair Programming Mode settings if they don't exist
                this.config.store.mcp.pairProgrammingMode = {
                    enabled: false,
                    autoFocusTerminal: true,
                    showConfirmationDialog: true,
                    showResultDialog: true
                };
                this.config.save();
            }
        } catch (error) {
            console.error('Error initializing MCP config:', error);
        }
    }

    private loadConfigValues(): void {
        console.log('Loading MCP config values');
        try {
            if (this.config.store.mcp) {
                this.serverUrl = this.config.store.mcp.serverUrl || 'http://localhost:3001';
                this.port = this.config.store.mcp.port || 3001;
                this.listenHost = this.config.store.mcp.listenHost || '127.0.0.1';
                this.enableDebugLogging = !!this.config.store.mcp.enableDebugLogging;
                this.startOnBoot = this.config.store.mcp.startOnBoot !== false; // Default to true if not set
                this.autoReconnect = this.config.store.mcp.autoReconnect === true;
                this.agentTabProfiles = [...(this.config.store.mcp.openTab?.profiles || [])];
                this.closeAgentTabsOnDisconnect = this.config.store.mcp.openTab?.closeOnDisconnect !== false;

                // Load Pair Programming Mode settings
                if (this.config.store.mcp.pairProgrammingMode) {
                    this.pairProgrammingEnabled = !!this.config.store.mcp.pairProgrammingMode.enabled;
                    this.autoFocusTerminal = this.config.store.mcp.pairProgrammingMode.autoFocusTerminal !== false; // Default to true
                    this.showConfirmationDialog = this.config.store.mcp.pairProgrammingMode.showConfirmationDialog !== false; // Default to true
                    this.showResultDialog = this.config.store.mcp.pairProgrammingMode.showResultDialog !== false; // Default to true
                }

                console.log('Loaded values:', {
                    serverUrl: this.serverUrl,
                    port: this.port,
                    enableDebugLogging: this.enableDebugLogging,
                    startOnBoot: this.startOnBoot,
                    pairProgrammingEnabled: this.pairProgrammingEnabled,
                    autoFocusTerminal: this.autoFocusTerminal,
                    showConfirmationDialog: this.showConfirmationDialog,
                    showResultDialog: this.showResultDialog
                });
            } else {
                console.warn('MCP config section not found');
            }
        } catch (error) {
            console.error('Error loading MCP config values:', error);
        }
    }

    saveServerUrl(): void {
        console.log(`Saving server URL: ${this.serverUrl}`);
        try {
            if (!this.config.store.mcp) {
                this.config.store.mcp = {};
            }
            this.config.store.mcp.serverUrl = this.serverUrl;
            this.config.save();
            this.logger.info(`Server URL updated to: ${this.serverUrl}`);
        } catch (error) {
            console.error('Error saving server URL:', error);
        }
    }

    savePort(): void {
        console.log(`Saving port: ${this.port}`);
        try {
            if (!this.config.store.mcp) {
                this.config.store.mcp = {};
            }
            this.config.store.mcp.port = this.port;
            this.config.save();
            this.logger.info(`Port updated to: ${this.port}`);
        } catch (error) {
            console.error('Error saving port:', error);
        }
    }

    saveListenHost(): void {
        console.log(`Saving listen host: ${this.listenHost}`);
        try {
            if (!this.config.store.mcp) {
                this.config.store.mcp = {};
            }
            this.config.store.mcp.listenHost = this.listenHost;
            this.config.save();
            this.logger.info(`Listen host updated to: ${this.listenHost}`);
        } catch (error) {
            console.error('Error saving listen host:', error);
        }
    }

    async startServer(): Promise<void> {
        console.log('Starting MCP server');
        try {
            await this.mcpService.startServer(this.port, this.listenHost);
            this.updateServerStatus();
            this.logger.info('MCP server started successfully');
        } catch (error) {
            console.error('Error starting MCP server:', error);
            this.logger.error('Failed to start MCP server', error);
        }
    }

    async stopServer(): Promise<void> {
        console.log('Stopping MCP server');
        try {
            await this.mcpService.stopServer();
            this.updateServerStatus();
            this.logger.info('MCP server stopped successfully');
        } catch (error) {
            console.error('Error stopping MCP server:', error);
            this.logger.error('Failed to stop MCP server', error);
        }
    }

    private async updateServerStatus(): Promise<void> {
        try {
            this.isServerRunning = await this.mcpService.isServerRunning();
            console.log(`Server status updated: ${this.isServerRunning ? 'running' : 'stopped'}`);
        } catch (error) {
            console.error('Error checking server status:', error);
        }
    }

    toggleDebugLogging(): void {
        console.log(`Toggling debug logging to: ${this.enableDebugLogging}`);
        try {
            if (!this.config.store.mcp) {
                this.config.store.mcp = {};
            }
            this.config.store.mcp.enableDebugLogging = this.enableDebugLogging;
            this.config.save();
            this.logger.setDebugEnabled(this.enableDebugLogging);
            this.logger.info(`Debug logging ${this.enableDebugLogging ? 'enabled' : 'disabled'}`);
        } catch (error) {
            console.error('Error toggling debug logging:', error);
        }
    }

    toggleStartOnBoot(): void {
        console.log(`Toggling start on boot to: ${this.startOnBoot}`);
        try {
            if (!this.config.store.mcp) {
                this.config.store.mcp = {};
            }
            this.config.store.mcp.startOnBoot = this.startOnBoot;
            this.config.save();
            this.logger.info(`Start on boot ${this.startOnBoot ? 'enabled' : 'disabled'}`);
        } catch (error) {
            console.error('Error toggling start on boot:', error);
        }
    }

    toggleAutoReconnect(): void {
        try {
            if (!this.config.store.mcp) {
                this.config.store.mcp = {};
            }
            this.config.store.mcp.autoReconnect = this.autoReconnect;
            this.config.save();
            this.logger.info(`Auto reconnect ${this.autoReconnect ? 'enabled' : 'disabled'}`);
        } catch (error) {
            console.error('Error toggling auto reconnect:', error);
        }
    }

    /**
     * Group saved profiles by group path, like Tabby's profile list
     */
    private async loadProfiles(): Promise<void> {
        try {
            const profiles = await this.profilesService.getProfiles({ includeBuiltin: false });
            const groups = new Map<string, AgentTabProfile[]>();
            for (const profile of profiles.filter(p => !p.isTemplate)) {
                const path = this.execToolCategory.groupPath(profile.group) ?? '';
                if (!groups.has(path)) {
                    groups.set(path, []);
                }
                groups.get(path)!.push({
                    id: profile.id,
                    name: profile.name,
                    icon: profile.icon ?? undefined,
                    color: profile.color ?? undefined,
                    description: this.profilesService.getDescription(profile) ?? '',
                });
            }
            // Ungrouped profiles last
            this.profileGroups = [...groups.entries()]
                .sort(([a], [b]) => (a === '') !== (b === '') ? (a === '' ? 1 : -1) : a.localeCompare(b))
                .map(([path, items]) => ({ path, profiles: items }));
        } catch (error) {
            console.error('Error loading profiles:', error);
        }
    }

    toggleAgentTabProfile(name: string, event: Event): void {
        try {
            const checked = (event.target as HTMLInputElement).checked;
            this.agentTabProfiles = checked
                ? [...this.agentTabProfiles.filter(n => n !== name), name]
                : this.agentTabProfiles.filter(n => n !== name);
            if (!this.config.store.mcp) {
                this.config.store.mcp = {};
            }
            if (!this.config.store.mcp.openTab) {
                this.config.store.mcp.openTab = {};
            }
            this.config.store.mcp.openTab.profiles = this.agentTabProfiles;
            this.config.save();
            this.logger.info(`Agent tab profiles updated: ${this.agentTabProfiles.join(', ') || '(none)'}`);
        } catch (error) {
            console.error('Error saving agent tab profiles:', error);
        }
    }

    toggleCloseAgentTabsOnDisconnect(): void {
        try {
            if (!this.config.store.mcp) {
                this.config.store.mcp = {};
            }
            if (!this.config.store.mcp.openTab) {
                this.config.store.mcp.openTab = {};
            }
            this.config.store.mcp.openTab.closeOnDisconnect = this.closeAgentTabsOnDisconnect;
            this.config.save();
            this.logger.info(`Close agent tabs on disconnect ${this.closeAgentTabsOnDisconnect ? 'enabled' : 'disabled'}`);
        } catch (error) {
            console.error('Error toggling close agent tabs on disconnect:', error);
        }
    }

    togglePairProgrammingMode(): void {
        console.log(`Toggling Pair Programming Mode to: ${this.pairProgrammingEnabled}`);
        try {
            if (!this.config.store.mcp) {
                this.config.store.mcp = {};
            }
            if (!this.config.store.mcp.pairProgrammingMode) {
                this.config.store.mcp.pairProgrammingMode = {};
            }
            this.config.store.mcp.pairProgrammingMode.enabled = this.pairProgrammingEnabled;
            this.config.save();
            this.logger.info(`Pair Programming Mode ${this.pairProgrammingEnabled ? 'enabled' : 'disabled'}`);
        } catch (error) {
            console.error('Error toggling Pair Programming Mode:', error);
        }
    }

    toggleAutoFocusTerminal(): void {
        console.log(`Toggling Auto Focus Terminal to: ${this.autoFocusTerminal}`);
        try {
            if (!this.config.store.mcp) {
                this.config.store.mcp = {};
            }
            if (!this.config.store.mcp.pairProgrammingMode) {
                this.config.store.mcp.pairProgrammingMode = {};
            }
            this.config.store.mcp.pairProgrammingMode.autoFocusTerminal = this.autoFocusTerminal;
            this.config.save();
            this.logger.info(`Auto Focus Terminal ${this.autoFocusTerminal ? 'enabled' : 'disabled'}`);
        } catch (error) {
            console.error('Error toggling Auto Focus Terminal:', error);
        }
    }

    toggleShowConfirmationDialog(): void {
        console.log(`Toggling Show Confirmation Dialog to: ${this.showConfirmationDialog}`);
        try {
            if (!this.config.store.mcp) {
                this.config.store.mcp = {};
            }
            if (!this.config.store.mcp.pairProgrammingMode) {
                this.config.store.mcp.pairProgrammingMode = {};
            }
            this.config.store.mcp.pairProgrammingMode.showConfirmationDialog = this.showConfirmationDialog;
            this.config.save();
            this.logger.info(`Show Confirmation Dialog ${this.showConfirmationDialog ? 'enabled' : 'disabled'}`);
        } catch (error) {
            console.error('Error toggling Show Confirmation Dialog:', error);
        }
    }

    toggleShowResultDialog(): void {
        console.log(`Toggling Show Result Dialog to: ${this.showResultDialog}`);
        try {
            if (!this.config.store.mcp) {
                this.config.store.mcp = {};
            }
            if (!this.config.store.mcp.pairProgrammingMode) {
                this.config.store.mcp.pairProgrammingMode = {};
            }
            this.config.store.mcp.pairProgrammingMode.showResultDialog = this.showResultDialog;
            this.config.save();
            this.logger.info(`Show Result Dialog ${this.showResultDialog ? 'enabled' : 'disabled'}`);
        } catch (error) {
            console.error('Error toggling Show Result Dialog:', error);
        }
    }
}
