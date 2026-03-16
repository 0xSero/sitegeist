import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getAppStorage } from "@mariozechner/pi-web-ui";

export const TOOL_SETTINGS_KEY = "tools.enabled";
export const TOOL_ALLOWED_DOMAINS_KEY = "tools.allowedDomains";

export const TOOL_LABELS: Record<string, string> = {
	navigate: "Navigate",
	ask_user_which_element: "Ask user which element",
	repl: "JavaScript REPL",
	skill: "Skills",
	extract_document: "Extract document",
	extract_image: "Extract image",
	debugger: "Debugger",
};

const DOMAIN_SCOPED_TOOLS = new Set([
	"navigate",
	"ask_user_which_element",
	"repl",
	"extract_document",
	"extract_image",
	"debugger",
]);

export type ToolEnabledMap = Record<string, boolean>;

export async function getToolSettings() {
	const storage = getAppStorage();
	const enabledMap = (await storage.settings.get<ToolEnabledMap>(TOOL_SETTINGS_KEY)) || {};
	const allowedDomainsRaw = (await storage.settings.get<string>(TOOL_ALLOWED_DOMAINS_KEY)) || "";
	return {
		enabledMap,
		allowedDomains: parseAllowedDomains(allowedDomainsRaw),
		allowedDomainsRaw,
	};
}

export function parseAllowedDomains(value: string): string[] {
	return value
		.split(/[\n,]/)
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}

async function isCurrentUrlAllowed(allowlist: string[]) {
	if (!allowlist.length) return true;
	try {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		if (!tab?.url) return false;
		const hostname = new URL(tab.url).hostname.toLowerCase();
		return allowlist.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
	} catch {
		return false;
	}
}

export function withToolSettings(tools: AgentTool<any, any>[], debuggerModeEnabled: boolean): AgentTool<any, any>[] {
	const result: AgentTool<any, any>[] = [];

	for (const tool of tools) {
		if (tool.name === "debugger" && !debuggerModeEnabled) continue;

		const originalExecute = tool.execute.bind(tool);
		const wrappedTool: AgentTool<any, any> = {
			...tool,
			execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: (update: any) => void) => {
				const { enabledMap, allowedDomains } = await getToolSettings();
				if (enabledMap[tool.name] === false) {
					throw new Error(`Tool "${tool.name}" is disabled in Settings > Tools.`);
				}
				if (DOMAIN_SCOPED_TOOLS.has(tool.name) && allowedDomains.length > 0) {
					const allowed = await isCurrentUrlAllowed(allowedDomains);
					if (!allowed) {
						throw new Error(
							`Tool "${tool.name}" is blocked by the allowed domains list. Update Settings > Tools to allow this domain.`,
						);
					}
				}
				return await originalExecute(toolCallId, params, signal, onUpdate);
			},
		};
		result.push(wrappedTool);
	}

	return result;
}
