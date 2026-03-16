import type { ToolDefinition } from "@sitegeist/shared";

export type RelayConnectionConfig = {
	relayUrl: string;
	relayToken: string;
	agentId: string;
	agentName: string;
	agentVersion: string;
	reconnectDelayBaseMs: number;
	reconnectDelayMaxMs: number;
};

export type AgentBrowserCommandConfig = {
	commandPrefix: string[];
	defaultTimeoutMs: number;
};

export type ElectronAgentConfig = RelayConnectionConfig & {
	agentBrowser: AgentBrowserCommandConfig;
};

export type JsonRecord = Record<string, unknown>;

export type AgentBrowserRunResult = {
	command: string[];
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	parsedJson?: unknown;
};

export type ElectronToolContext = {
	agentBrowser: AgentBrowserCommandConfig;
};

export type ElectronToolHandler = (args: JsonRecord, context: ElectronToolContext) => Promise<unknown>;

export type ElectronToolRegistryEntry = {
	definition: ToolDefinition;
	handler: ElectronToolHandler;
};
