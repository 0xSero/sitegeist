import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createExtractDocumentTool, type SandboxRuntimeProvider } from "@mariozechner/pi-web-ui";
import { DebuggerTool } from "../tools/debugger.js";
import { ExtractImageTool } from "../tools/extract-image.js";
import { AskUserWhichElementTool, skillTool } from "../tools/index.js";
import { NativeInputEventsRuntimeProvider } from "../tools/NativeInputEventsRuntimeProvider.js";
import { NavigateTool } from "../tools/navigate.js";
import { createOrchestratorTools } from "../tools/orchestrator.js";
import { createReplTool } from "../tools/repl/repl.js";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "../tools/repl/runtime-providers.js";
import { withToolSettings } from "../tools/tool-settings.js";

export type SitegeistToolFactoryOptions = {
	currentWindowId: number;
	debuggerModeEnabled: boolean;
	corsProxyEnabled?: boolean;
	corsProxyUrl?: string;
	sandboxUrlProvider: () => string;
	ensureSessionId?: () => Promise<string>;
	runtimeProvidersFactory?: () => SandboxRuntimeProvider[];
};

export function createSitegeistTools({
	currentWindowId,
	debuggerModeEnabled,
	corsProxyEnabled = false,
	corsProxyUrl,
	sandboxUrlProvider,
	ensureSessionId,
	runtimeProvidersFactory,
}: SitegeistToolFactoryOptions): AgentTool<any, any>[] {
	const navigateTool = new NavigateTool();
	const selectElementTool = new AskUserWhichElementTool();

	const extractDocumentTool = createExtractDocumentTool();
	if (corsProxyEnabled && corsProxyUrl) {
		extractDocumentTool.corsProxyUrl = `${corsProxyUrl}/?url=`;
	}

	const replTool = createReplTool();
	replTool.sandboxUrlProvider = sandboxUrlProvider;
	replTool.runtimeProvidersFactory = () => {
		const sharedProviders = runtimeProvidersFactory?.() ?? [];
		const pageProviders = [...sharedProviders, new NativeInputEventsRuntimeProvider()];
		return [...pageProviders, new BrowserJsRuntimeProvider(pageProviders), new NavigateRuntimeProvider(navigateTool)];
	};

	const extractImageTool = new ExtractImageTool();
	extractImageTool.windowId = currentWindowId;

	const tools: AgentTool<any, any>[] = [
		navigateTool,
		selectElementTool,
		replTool,
		skillTool,
		extractDocumentTool,
		extractImageTool,
		...(ensureSessionId ? createOrchestratorTools({ ensureSessionId }) : []),
	];

	if (debuggerModeEnabled) {
		tools.push(new DebuggerTool());
	}

	return withToolSettings(tools, debuggerModeEnabled);
}
