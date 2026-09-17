import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
} from "@mariozechner/pi-agent-core";
import { getModel, getModels, type Model } from "@mariozechner/pi-ai";
import {
	ChatPanel,
	createExtractDocumentTool,
	createStreamFn,
	ModelSelector,
	ProxyTab,
	SettingsDialog,
	// PersistentStorageDialog,
	setAppStorage,
	setShowJsonMode,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { Circle, Download, History, Link, Plus, Settings, Square } from "lucide";
import { isRestrictedUrl } from "./browser/cdp.js";
import { setCurrentBrowserSession } from "./browser/current.js";
import { dispatchToSandbox, setCdpMessageHandler } from "./browser/inject.js";
import { BrowserSession, listSessions } from "./browser/session.js";
import { Toast } from "./components/Toast.js";
import { AboutTab } from "./dialogs/AboutTab.js";
import { ApiKeyOrOAuthDialog } from "./dialogs/ApiKeyOrOAuthDialog.js";
import { ApiKeysOAuthTab } from "./dialogs/ApiKeysOAuthTab.js";
import { BridgeTab } from "./dialogs/BridgeTab.js";
import { CostsTab } from "./dialogs/CostsTab.js";
import { CustomProvidersTab } from "./dialogs/CustomProvidersTab.js";
import { RecordSkillDialog } from "./dialogs/RecordSkillDialog.js";
import { SessionCostDialog } from "./dialogs/SessionCostDialog.js";
import { SitegeistSessionListDialog } from "./dialogs/SessionListDialog.js";
import { SkillsTab } from "./dialogs/SkillsTab.js";
import { UpdateNotificationDialog } from "./dialogs/UpdateNotificationDialog.js";
import { WelcomeSetupDialog } from "./dialogs/WelcomeSetupDialog.js";
import { browserMessageTransformer } from "./messages/message-transformer.js";
import {
	createNavigationMessage,
	type NavigationMessage,
	registerNavigationRenderer,
} from "./messages/NavigationMessage.js";
import { registerUserMessageRenderer } from "./messages/UserMessageRenderer.js";
import { createWelcomeMessage, registerWelcomeRenderer } from "./messages/WelcomeMessage.js";
import { refreshDiscoveredModels } from "./models/registry.js";
import { isOAuthCredentials, resolveApiKey } from "./oauth/index.js";
import { SYSTEM_PROMPT } from "./prompts/prompts.js";
import { Recorder } from "./recording/recorder.js";
import { SitegeistAppStorage } from "./storage/app-storage.js";
import { DebuggerTool } from "./tools/debugger.js";
import { ExtractImageTool, registerExtractImageRenderer } from "./tools/extract-image.js";
import { AskUserWhichElementTool, skillTool } from "./tools/index.js";
import { NativeInputEventsRuntimeProvider } from "./tools/NativeInputEventsRuntimeProvider.js";
import { isToolNavigating, NavigateTool } from "./tools/navigate.js";
import { createReplTool } from "./tools/repl/repl.js";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "./tools/repl/runtime-providers.js";
import { syncCustomProviderCorsRules } from "./utils/custom-provider-cors.js";
import { downloadChatMarkdown } from "./utils/export-chat.js";
import * as port from "./utils/port.js";
import "./utils/i18n-extension.js";
import "./utils/live-reload.js";
import { tutorials } from "./tutorials.js";

// Register custom message renderers
registerNavigationRenderer();
registerExtractImageRenderer();

// Listen for abort messages from REPL overlay
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	console.log("[Sidepanel] Received message:", message, "from:", sender);
	if (message.type === "abort-repl") {
		console.log("[Sidepanel] Abort-repl message received, agent streaming:", agent?.state.isStreaming);
		if (agent?.state.isStreaming) {
			console.log("[Sidepanel] Aborting agent...");
			agent.abort();
			sendResponse({ success: true });
		} else {
			console.log("[Sidepanel] Agent not streaming, ignoring");
			sendResponse({ success: false, reason: "not-streaming" });
		}
		return true; // Keep channel open for async response
	}
});

// Messages from code injected through the debugger path (no userScripts API) arrive
// here instead of chrome.runtime.onMessage; route them exactly the same way.
setCdpMessageHandler(async (message) => {
	if (message.type === "abort-repl") {
		if (agent?.state.isStreaming) {
			agent.abort();
			return { success: true };
		}
		return { success: false, reason: "not-streaming" };
	}
	return dispatchToSandbox(message);
});

// ============================================================================
// STORAGE SETUP
// ============================================================================
const storage = new SitegeistAppStorage();
setAppStorage(storage);

// ============================================================================
// APP STATE
// ============================================================================
let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let currentWindowId: number;

// Track which skills we've shown in full (skillName -> lastUpdated timestamp)
// Reset when a new session/agent is created
const shownSkills = new Map<string, string>();

// Track which messages we've already recorded costs for (avoid duplicates)
// Use Set with message object identity (not cleared on session switch - persists in memory)
const recordedCostMessages = new Set<AgentMessage>();

// Cached auth type label for the current provider
let authLabel = "";

// Interaction recorder (record → save as site-scoped skill)
let recorder: Recorder | undefined;
let isRecording = false;

// The tabs this chat session owns (its own tab group; never the user's tabs)
let browserSession: BrowserSession | undefined;
let tempBrowserSessionId: string | undefined;

function sessionLabel(): string {
	const title = currentTitle.trim();
	if (!title) return "chat";
	return title.length > 28 ? `${title.slice(0, 27)}…` : title;
}

async function openBrowserSession(id: string): Promise<void> {
	browserSession = await BrowserSession.open(id, sessionLabel(), currentWindowId);
	setCurrentBrowserSession(browserSession);
	renderApp();
}

/** Unsaved chats get a throwaway session id until they are persisted. */
function ensureTempBrowserSessionId(): string {
	if (!tempBrowserSessionId) tempBrowserSessionId = `temp-${crypto.randomUUID()}`;
	return tempBrowserSessionId;
}

/** Temp sessions that never got a tab are noise; drop them at startup. */
async function pruneEmptyTempSessions(): Promise<void> {
	for (const s of await listSessions()) {
		if (s.id.startsWith("temp-") && s.tabIds.length === 0) {
			const session = await BrowserSession.open(s.id, s.label, s.windowId);
			await session.close();
		}
	}
}

/** User gesture: hand the tab they are looking at to the agent. */
async function shareActiveTab(): Promise<void> {
	if (!browserSession) return;
	const [tab] = await chrome.tabs.query({ active: true, windowId: currentWindowId });
	if (!tab?.id || !tab.url || isRestrictedUrl(tab.url)) {
		Toast.error("This page cannot be shared with the agent");
		return;
	}
	await browserSession.adopt(tab.id, true);
	Toast.success("Tab shared with the agent");
	renderApp();
}

/**
 * Slash-command provider for the chat input: lists skills (recordings included),
 * site-scoped first, and inserts an @skill:<id> reference the agent retrieves.
 */
function buildSkillSlashProvider() {
	return async (query: string) => {
		let url: string | undefined;
		try {
			url = (await browserSession?.currentTab())?.url;
		} catch {
			/* ignore */
		}
		const all = await storage.skills.list();
		const onSite = url ? await storage.skills.list(url) : [];
		const onSiteNames = new Set(onSite.map((s) => s.name));
		const ordered = [...onSite, ...all.filter((s) => !onSiteNames.has(s.name))];
		const q = query.toLowerCase();
		const filtered = q
			? ordered.filter(
					(s) => s.name.toLowerCase().includes(q) || (s.shortDescription || "").toLowerCase().includes(q),
				)
			: ordered;
		return filtered.slice(0, 20).map((s) => ({
			id: s.name,
			title: s.name,
			description: s.shortDescription,
			hint: onSiteNames.has(s.name) ? "this site" : s.domainPatterns[0],
			value: `@skill:${s.name}`,
		}));
	};
}

async function toggleRecording() {
	if (isRecording && recorder) {
		const current = recorder;
		recorder = undefined;
		isRecording = false;
		renderApp();
		try {
			const result = await current.stop();
			RecordSkillDialog.open(result);
		} catch (err) {
			console.error("Failed to stop recording:", err);
			Toast.error("Failed to stop recording");
		}
		return;
	}

	const next = new Recorder();
	try {
		await next.start();
		recorder = next;
		isRecording = true;
		Toast.success("Recording — interact with the page, then click stop");
		renderApp();
	} catch (err) {
		console.error("Failed to start recording:", err);
		Toast.error("Cannot record this page");
	}
}

function downloadCurrentChat() {
	if (!agent) return;
	const messages = agent.state.messages.filter((m) => m.role !== "welcome");
	if (messages.length === 0) {
		Toast.error("Nothing to export yet");
		return;
	}
	downloadChatMarkdown(messages, currentTitle || "Sitegeist chat", agent.state.model);
}

const DEFAULT_MODELS: Record<string, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	anthropic: "claude-sonnet-4-6",
	"azure-openai-responses": "gpt-5.2",
	cerebras: "zai-glm-4.6",
	"github-copilot": "gpt-4o",
	google: "gemini-2.5-flash",
	"google-antigravity": "gemini-3.1-pro-high",
	"google-gemini-cli": "gemini-2.5-pro",
	"google-vertex": "gemini-3-pro-preview",
	groq: "openai/gpt-oss-20b",
	huggingface: "moonshotai/Kimi-K2.5",
	"kimi-coding": "kimi-k2-thinking",
	minimax: "MiniMax-M2.1",
	"minimax-cn": "MiniMax-M2.1",
	mistral: "devstral-medium-latest",
	openai: "gpt-4o-mini",
	"openai-codex": "gpt-5.5",
	opencode: "claude-opus-4-6",
	"opencode-go": "kimi-k2.5",
	openrouter: "openai/gpt-5.1-codex",
	"vercel-ai-gateway": "anthropic/claude-opus-4-6",
	xai: "grok-4-fast-non-reasoning",
	zai: "glm-4.6",
};

async function selectDefaultModelForAvailableProvider() {
	const providers = await getProvidersWithKeys();
	if (providers.length === 0 || !agent) return;

	// Try each provider with keys and find a default model
	for (const provider of providers) {
		const modelId = DEFAULT_MODELS[provider];
		if (modelId) {
			const model = getModel(provider as any, modelId);
			if (model) {
				agent.setModel(model);
				await storage.settings.set("lastUsedModel", model);
				await updateAuthLabel();
				renderApp();
				return;
			}
		}
	}

	// If no default found, try the first model for the first provider with a key
	for (const provider of providers) {
		const models = getModels(provider as any);
		if (models.length > 0) {
			agent.setModel(models[0]);
			await storage.settings.set("lastUsedModel", models[0]);
			await updateAuthLabel();
			renderApp();
			return;
		}
	}

	// Fall back to the first model of a custom provider (not in the built-in registry)
	const customProviders = await storage.customProviders.getAll();
	for (const customProvider of customProviders) {
		const model = customProvider.models?.[0];
		if (model) {
			agent.setModel(model);
			await storage.settings.set("lastUsedModel", model);
			await updateAuthLabel();
			renderApp();
			return;
		}
	}
}

async function getProvidersWithKeys(): Promise<string[]> {
	const providers = await storage.providerKeys.list();
	const result: string[] = [];
	for (const provider of providers) {
		const key = await storage.providerKeys.get(provider);
		if (key) result.push(provider);
	}
	return result;
}

async function hasAnyApiKey(): Promise<boolean> {
	const providers = await storage.providerKeys.list();
	return providers.length > 0;
}

function openApiKeysDialog(): Promise<void> {
	return new Promise((resolve) => {
		SettingsDialog.open(
			[
				new ApiKeysOAuthTab(),
				new CustomProvidersTab(),
				new CostsTab(),
				new SkillsTab(),
				new BridgeTab(),
				new ProxyTab(),
				new AboutTab(),
			],
			resolve,
		);
	});
}

async function updateAuthLabel() {
	if (!agent) {
		authLabel = "";
		return;
	}
	const provider = agent.state.model.provider;
	const stored = await storage.providerKeys.get(provider);
	if (!stored) {
		authLabel = "";
	} else if (isOAuthCredentials(stored)) {
		authLabel = "subscription";
	} else {
		authLabel = "api key";
	}
}

// Export getter for message transformer
export function getShownSkills(): Map<string, string> {
	return shownSkills;
}

// ============================================================================
// HELPERS
// ============================================================================
const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user");
	if (!firstUserMsg || firstUserMsg.role !== "user") return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c) => c.type === "text");
		text = textBlocks.map((c) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m: AgentMessage) => m.role === "user");
	const hasAssistantMsg = messages.some((m: AgentMessage) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;

	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		// Calculate cumulative usage from all assistant messages
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		for (const msg of state.messages) {
			if (msg.role === "assistant") {
				usage.input += msg.usage.input;
				usage.output += msg.usage.output;
				usage.cacheRead += msg.usage.cacheRead;
				usage.cacheWrite += msg.usage.cacheWrite;
				usage.totalTokens += msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
				if (msg.usage.cost) {
					usage.cost.input += msg.usage.cost.input;
					usage.cost.output += msg.usage.cost.output;
					usage.cost.cacheRead += msg.usage.cost.cacheRead;
					usage.cost.cacheWrite += msg.usage.cost.cacheWrite;
					usage.cost.total += msg.usage.cost.total;
				}
			}
		}

		// Generate preview text (first 2KB of user + assistant text)
		let preview = "";
		for (const msg of state.messages) {
			if (preview.length >= 2048) break;
			if (msg.role === "user") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join("\n") || "";
				preview += `${text}\n`;
			} else if (msg.role === "assistant") {
				const text = msg.content
					.filter((c) => c.type === "text" || c.type === "thinking")
					.map((c) => (c.type === "text" ? c.text : c.thinking))
					.join("\n");
				preview += `${text}\n`;
			}
		}
		preview = preview.substring(0, 2048);

		// Preserve createdAt if session already exists
		const existingMetadata = await storage.sessions.getMetadata(currentSessionId);
		const createdAt = existingMetadata?.createdAt || new Date().toISOString();

		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt,
			lastModified: new Date().toISOString(),
			messageCount: state.messages.length,
			usage,
			modelId: state.model.id,
			thinkingLevel: state.thinkingLevel,
			preview,
		};

		await storage.sessions.saveSession(currentSessionId, state, metadata, currentTitle);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

const createAgent = async (initialState?: Partial<AgentState>, shouldSave = true) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	// Mark all loaded messages as already recorded (by object identity)
	for (const msg of initialState?.messages || []) {
		if (msg.role === "assistant" && msg.usage?.cost?.total > 0) {
			recordedCostMessages.add(msg);
		}
	}

	// Reset skill tracking for new session
	// When loading an old session, we intentionally don't reconstruct shownSkills
	// This ensures that new navigations in the continued session show the LATEST
	// version of skills, even if they were updated since the session was created
	shownSkills.clear();

	// Every chat owns a browser session; unsaved chats use a temporary id until first save
	await openBrowserSession(currentSessionId ?? ensureTempBrowserSessionId());

	// Load debugger mode setting
	const stored = await chrome.storage.local.get("debuggerMode");
	const debuggerModeEnabled = stored.debuggerMode || false;

	// Load CORS proxy settings for extract_document tool
	const corsProxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
	const corsProxyUrl = await storage.settings.get<string>("proxy.url");

	// Determine default model: saved > default for a provider with key > gemini flash fallback
	let defaultModel: Model<any> | undefined;
	if (!initialState?.model) {
		const savedModel = await storage.settings.get<Model<any>>("lastUsedModel");
		if (savedModel) {
			defaultModel = savedModel;
		} else {
			// Try to find a default model for a provider the user already has a key for
			const providersWithKeys = await getProvidersWithKeys();
			for (const provider of providersWithKeys) {
				const modelId = DEFAULT_MODELS[provider];
				if (modelId) {
					const model = getModel(provider as any, modelId);
					if (model) {
						defaultModel = model;
						break;
					}
				}
			}
		}
	}
	// Final fallback
	if (!defaultModel && !initialState?.model) {
		defaultModel = getModel("anthropic", "claude-sonnet-4-6");
	}

	agent = new Agent({
		initialState: initialState || {
			systemPrompt: SYSTEM_PROMPT,
			model: defaultModel,
			thinkingLevel: "medium",
			messages: [],
			tools: [],
		},
		convertToLlm: browserMessageTransformer,
		toolExecution: "sequential",
		streamFn: createStreamFn(async () => {
			const enabled = await storage.settings.get<boolean>("proxy.enabled");
			if (!enabled) return undefined;
			return (await storage.settings.get<string>("proxy.url")) || undefined;
		}),
		getApiKey: async (provider: string) => {
			const stored = await storage.providerKeys.get(provider);
			if (!stored) return undefined;
			const proxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
			const proxyUrl = proxyEnabled ? (await storage.settings.get<string>("proxy.url")) || undefined : undefined;
			return resolveApiKey(stored, provider, storage.providerKeys, proxyUrl);
		},
	});

	await updateAuthLabel();

	if (shouldSave) {
		agentUnsubscribe = agent.subscribe((event: AgentEvent) => {
			const messages = agent.state.messages;

			storage.settings
				.set("lastUsedModel", agent.state.model)
				.catch((err) => console.error("Failed to save lastUsedModel:", err));

			// Update auth label when model changes
			updateAuthLabel().catch(() => {});

			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.usage?.cost?.total > 0
			) {
				if (!recordedCostMessages.has(event.message)) {
					recordedCostMessages.add(event.message);
					storage.costs
						.recordCost(agent.state.model.provider, agent.state.model.id, event.message.usage.cost.total)
						.catch((err) => console.error("Failed to record cost:", err));
				}
			}

			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
				browserSession?.setLabel(sessionLabel()).catch(() => {});
			}

			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();
				if (tempBrowserSessionId) {
					const tempId = tempBrowserSessionId;
					const newId = currentSessionId;
					tempBrowserSessionId = undefined;
					BrowserSession.rename(tempId, newId)
						.then(() => openBrowserSession(newId))
						.catch((err) => console.error("Failed to rename browser session:", err));
				}

				port
					.sendMessage({
						type: "acquireLock",
						sessionId: currentSessionId,
						windowId: currentWindowId,
					})
					.then((lockResponse) => {
						if (!lockResponse.success) {
							console.warn("Failed to acquire lock for newly created session", currentSessionId);
						}
					});
				updateUrl(currentSessionId);
			}

			if (currentSessionId) {
				saveSession();
			}

			renderApp();
		});
	}

	await chatPanel.setAgent(agent, {
		sandboxUrlProvider: () => {
			return chrome.runtime.getURL("sandbox.html");
		},
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyOrOAuthDialog.prompt(provider);
		},
		onModelSelect: async () => {
			const providers = await getProvidersWithKeys();
			if (providers.length === 0) {
				openApiKeysDialog();
				return;
			}
			// Cached lists are already registered; give stale providers a moment to refresh.
			await refreshDiscoveredModels(storage, { wait: true, timeoutMs: 4000 }).catch(() => {});
			ModelSelector.open(
				agent.state.model,
				(model) => {
					agent.setModel(model);
					chatPanel.agentInterface?.requestUpdate();
					updateAuthLabel().catch(() => {});
					renderApp();
				},
				providers,
				{
					level: agent.state.thinkingLevel,
					onChange: (level) => {
						agent.setThinkingLevel(level);
						chatPanel.agentInterface?.requestUpdate();
						saveSession();
						renderApp();
					},
				},
			);
		},
		onBeforeSend: async () => {
			if (!agent) return;

			// The session's current tab (nothing if the session has no tab yet)
			const tab = await browserSession?.currentTab();
			if (!tab?.url || isRestrictedUrl(tab.url)) return;

			// Find most recent navigation (either nav message or nav tool result)
			let lastUrl: string | undefined;
			for (let i = agent.state.messages.length - 1; i >= 0; i--) {
				const msg = agent.state.messages[i];
				if (msg.role === "navigation") {
					lastUrl = (msg as NavigationMessage).url;
					break;
				}
				if (msg.role === "toolResult" && (msg as any).toolName === "navigate") {
					lastUrl = (msg as any).details?.finalUrl;
					break;
				}
			}

			// Only add if URL changed
			if (!lastUrl || lastUrl !== tab.url) {
				const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
				agent.appendMessage(navMessage);
			}
		},
		onCostClick: () => {
			if (!agent) return;
			SessionCostDialog.open(agent.state.messages);
		},
		toolsFactory: (_agent, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
			const navigateTool = new NavigateTool();
			const selectElementTool = new AskUserWhichElementTool();

			// Create extract_document tool with CORS proxy from settings (loaded above)
			const extractDocumentTool = createExtractDocumentTool();
			if (corsProxyEnabled && corsProxyUrl) {
				extractDocumentTool.corsProxyUrl = `${corsProxyUrl}/?url=`;
			}

			const replTool = createReplTool();
			replTool.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");

			// Extend base providers with browser orchestration capabilities
			replTool.runtimeProvidersFactory = () => {
				// Providers that should be available in page context via browserjs()
				const pageProviders = [
					...runtimeProvidersFactory(), // attachments + artifacts from ChatPanel
					new NativeInputEventsRuntimeProvider(), // trusted browser events
				];

				return [
					...pageProviders, // Make them available in REPL context too
					new BrowserJsRuntimeProvider(pageProviders), // Pass to page context
					new NavigateRuntimeProvider(navigateTool),
				];
			};

			const extractImageTool = new ExtractImageTool();

			const tools: AgentTool<any, any>[] = [
				navigateTool,
				selectElementTool,
				replTool,
				skillTool,
				extractDocumentTool,
				extractImageTool,
			];

			// Conditionally add debugger tool if enabled
			if (debuggerModeEnabled) {
				const debuggerTool = new DebuggerTool();
				tools.push(debuggerTool);
			}

			return tools;
		},
	});

	// Register custom message renderers after agentInterface is available
	if (chatPanel.agentInterface) {
		registerWelcomeRenderer(agent, chatPanel.agentInterface);

		// Thinking level now lives inside the model picker, not as a separate
		// dropdown in the input toolbar.
		chatPanel.agentInterface.enableThinkingSelector = false;
		// "/" in the chat input lists skills (recordings included) for the site.
		chatPanel.agentInterface.slashCommandProvider = buildSkillSlashProvider();
		chatPanel.agentInterface.requestUpdate();

		// Only disable auto-scroll for new sessions with welcome message
		// Check if this is a fresh session (only has welcome message, no user messages)
		const hasUserMessage = agent.state.messages.some((m) => m.role === "user");
		if (!hasUserMessage) {
			chatPanel.agentInterface.setAutoScroll(false);

			// Re-enable auto-scroll on first user message
			let unsubscribe: (() => void) | undefined;
			unsubscribe = agent.subscribe(() => {
				const hasUserMsg = agent.state.messages.some((m) => m.role === "user");
				if (hasUserMsg && unsubscribe) {
					chatPanel.agentInterface?.setAutoScroll(true);
					unsubscribe();
				}
			});
		}
	}
};

const loadSession = (sessionId: string) => {
	// Navigation will disconnect port and auto-release locks
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.location.href = url.toString();
};

const newSession = () => {
	// Navigation will disconnect port and auto-release locks
	const url = new URL(window.location.href);
	url.search = "?new=true";
	window.location.href = url.toString();
};

// ============================================================================
// RENDER
// ============================================================================
const renderApp = () => {
	const appHtml = html`
		<div class="w-full h-full flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-3 py-2">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							SitegeistSessionListDialog.open(
								(sessionId: string) => {
									loadSession(sessionId);
								},
								(deletedSessionId: string) => {
									// Only reload if the current session was deleted
									if (deletedSessionId === currentSessionId) {
										newSession();
									}
								},
							);
						},
						title: "Sessions",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Plus, "sm"),
						onClick: newSession,
						title: "New Session",
					})}

					${
						currentTitle
							? isEditingTitle
								? html`<div class="flex items-center gap-2">
									${Input({
										type: "text",
										value: currentTitle,
										className: "text-sm w-48",
										/*
										TODO need to add this in Input in mini-lit
										onBlur: async (e: Event) => {
											const newTitle = (e.target as HTMLInputElement).value.trim();
											if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
												await storage.sessions.updateTitle(currentSessionId, newTitle);
												currentTitle = newTitle;
											}
											isEditingTitle = false;
											renderApp();
										},*/
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
													await storage.sessions.updateTitle(currentSessionId, newTitle);
													currentTitle = newTitle;
												}
												isEditingTitle = false;
												renderApp();
											} else if (e.key === "Escape") {
												isEditingTitle = false;
												renderApp();
											}
										},
									})}
								</div>`
								: html`<button
									class="px-2 py-1 text-xs text-foreground hover:bg-secondary rounded transition-colors truncate max-w-[150px]"
									@click=${() => {
										isEditingTitle = true;
										renderApp();
										requestAnimationFrame(() => {
											const input = document.body.querySelector('input[type="text"]') as HTMLInputElement;
											if (input) {
												input.focus();
												input.select();
											}
										});
									}}
									title="Click to edit title"
								>
									${currentTitle}
								</button>`
							: html``
					}
				</div>
				<div class="flex items-center gap-1 px-2">
					${agent ? html`<span class="text-[10px] text-muted-foreground truncate max-w-[120px]" title="${agent.state.model.provider}/${agent.state.model.id}${authLabel ? ` (${authLabel})` : ""}">${agent.state.model.provider}${authLabel ? html` <span class="text-[9px] opacity-70">${authLabel}</span>` : ""}</span>` : ""}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Link, "sm"),
						onClick: shareActiveTab,
						title: "Share the tab you are viewing with the agent",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(isRecording ? Square : Circle, "sm"),
						className: isRecording ? "text-red-500 animate-pulse" : "",
						onClick: toggleRecording,
						title: isRecording ? "Stop recording and save as skill" : "Record actions on this page as a skill",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Download, "sm"),
						onClick: downloadCurrentChat,
						title: "Download chat (Markdown)",
					})}
					<theme-toggle></theme-toggle>
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () =>
							SettingsDialog.open([
								new ApiKeysOAuthTab(),
								new CustomProvidersTab(),
								new CostsTab(),
								new SkillsTab(),
								new BridgeTab(),
								new ProxyTab(),
								new AboutTab(),
							]),
						title: "Settings",
					})}
				</div>
			</div>

			<!-- Chat Panel -->
			${chatPanel}
		</div>
	`;

	render(appHtml, document.body);
};

// ============================================================================
// TAB NAVIGATION TRACKING
// ============================================================================

// The agent only hears about URL changes on its own current tab (a page redirecting
// or the user navigating a shared tab). The user's other tabs are never observed.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
	if (
		changeInfo.url &&
		tab.url &&
		browserSession?.currentTabId === tabId &&
		agent?.state.isStreaming &&
		!isRestrictedUrl(tab.url) &&
		!isToolNavigating()
	) {
		const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
		agent.steer(navMessage);
		console.log("Queued navigation message for", tab.url);
	}
});

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================
window.addEventListener(
	"keydown",
	(e) => {
		// Escape key to abort streaming - works globally in sidepanel
		// Use capturing phase to intercept before MessageEditor handles it
		if (e.key === "Escape" && agent?.state.isStreaming) {
			e.preventDefault();
			e.stopPropagation();
			agent.abort();
		}

		// Cmd+U (Mac) or Ctrl+U (Windows/Linux) to open debug page
		if ((e.metaKey || e.ctrlKey) && e.key === "u") {
			e.preventDefault();
			window.location.href = "./debug.html";
		}

		// Cmd+Shift+K (Mac) or Ctrl+Shift+K (Windows/Linux) to show session costs
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
			e.preventDefault();
			if (agent?.state.messages && agent.state.messages.length > 0) {
				SessionCostDialog.open(agent.state.messages);
			}
		}
	},
	true,
); // Use capture phase to intercept Escape before it reaches MessageEditor

// ============================================================================
// TEST STEPS FROM DEBUGGER.TS
// ============================================================================
async function testSteps(): Promise<boolean> {
	const urlParams = new URLSearchParams(window.location.search);
	const testStepsParam = urlParams.get("teststeps");
	const testProvider = urlParams.get("provider");
	const testModel = urlParams.get("model");

	if (!testStepsParam) return false;

	// Handle test prompts - create temporary session without saving
	try {
		const testSteps = JSON.parse(decodeURIComponent(testStepsParam)) as string[];

		// Set model if specified
		let initialState: Partial<AgentState> | undefined;
		if (testProvider && testModel) {
			const model = getModel(testProvider as any, testModel);
			if (model) {
				initialState = {
					systemPrompt: SYSTEM_PROMPT,
					model,
				};
			}
		}

		await createAgent(initialState, false);
		renderApp();

		// Wait for UI to render
		await new Promise((resolve) => requestAnimationFrame(resolve));

		// Submit prompts sequentially
		for (let i = 0; i < testSteps.length; i++) {
			const step = testSteps[i];
			if (!chatPanel?.agentInterface) break;

			// Send the prompt
			await chatPanel.agentInterface.sendMessage(step);

			// Wait for agent to finish (not streaming anymore)
			if (i < testSteps.length - 1) {
				// Wait for response to complete before sending next step
				await new Promise<void>((resolve) => {
					const checkComplete = () => {
						if (!chatPanel.agent?.state.isStreaming) {
							resolve();
						} else {
							setTimeout(checkComplete, 100);
						}
					};
					checkComplete();
				});
			}
		}
		return true;
	} catch (err) {
		console.error("Failed to run test steps:", err);
		return false;
	}
}

// ============================================================================
// UPDATE CHECK
// ============================================================================
function isNewerVersion(latest: string, current: string): boolean {
	const latestParts = latest.split(".").map(Number);
	const currentParts = current.split(".").map(Number);

	for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
		const l = latestParts[i] || 0;
		const c = currentParts[i] || 0;
		if (l > c) return true;
		if (l < c) return false;
	}
	return false;
}

async function checkForUpdates() {
	try {
		const currentVersion = chrome.runtime.getManifest().version;

		// Fetch latest version
		const response = await fetch("https://sitegeist.ai/uploads/version.json", {
			cache: "no-cache",
		});
		const data = await response.json();
		const latestVersion = data.version;

		// Show dialog only if server version is newer than current version
		if (isNewerVersion(latestVersion, currentVersion)) {
			// Show update dialog - blocks until extension is updated and restarted
			await UpdateNotificationDialog.show(latestVersion);
		}
	} catch (err) {
		console.warn("[Sidepanel] Failed to check for updates:", err);
		// Silently fail - don't block startup
	}
}

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	// Show loading
	render(
		html`
			<div class="w-full h-full flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Loading...</div>
			</div>
		`,
		document.body,
	);

	// Load showJsonMode setting
	const stored = await chrome.storage.local.get("showJsonMode");
	const showJsonModeEnabled = (stored.showJsonMode as boolean) || false;
	setShowJsonMode(showJsonModeEnabled);

	// Reconcile CORS rules for any configured custom providers (dynamic DNR rules
	// don't ship in the static manifest, so make sure they exist after a reload).
	syncCustomProviderCorsRules().catch((err) => console.error("Failed to sync custom provider CORS rules:", err));

	// Get current window ID for filtering tab events
	const currentWindow = await chrome.windows.getCurrent();
	if (!currentWindow.id) {
		throw new Error("Failed to get current window ID");
	}
	currentWindowId = currentWindow.id;

	// Initialize port communication system
	port.initialize(currentWindowId);

	pruneEmptyTempSessions().catch(() => {});

	// Register cached provider model lists now; refresh stale ones in the background.
	refreshDiscoveredModels(storage).catch((err) => console.warn("Model discovery failed:", err));

	// TODO reenable Request persistent storage
	// if (storage.sessions) {
	// 	await PersistentStorageDialog.request();
	// }

	// In-page scripts use the userScripts API when the browser exposes it and fall back
	// to an isolated content-script world otherwise, so no permission prompt is needed.

	// TODO: re-enable update check when publishing to users
	// await checkForUpdates();

	// Initialize default skills
	const { initializeDefaultSkills } = await import("./tools/skill.js");
	await initializeDefaultSkills();

	// Proxy disabled — CORS is handled locally via declarativeNetRequest rules
	await storage.settings.set("proxy.enabled", false);

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Handle test steps
	if (await testSteps()) {
		return;
	}

	// Check for session in URL
	const urlParams = new URLSearchParams(window.location.search);
	let sessionIdFromUrl = urlParams.get("session");
	const isNewSession = urlParams.get("new") === "true";

	// If no session in URL and not explicitly creating new, try to load the most recent session
	if (!sessionIdFromUrl && !isNewSession && storage.sessions) {
		const latestSessionId = await storage.sessions.getLatestSessionId();
		if (latestSessionId) {
			// Try to acquire lock for latest session
			const lockResponse = await port.sendMessage({
				type: "acquireLock",
				sessionId: latestSessionId,
				windowId: currentWindowId,
			});

			if (lockResponse.success) {
				sessionIdFromUrl = latestSessionId;
				// Update URL to include the latest session
				updateUrl(latestSessionId);
			}
			// If lock fails, fall through to create new session
		}
	}

	if (sessionIdFromUrl && storage.sessions) {
		const sessionData = await storage.sessions.loadSession(sessionIdFromUrl);
		if (sessionData) {
			// Try to acquire lock if we don't already have it (in case user navigated directly via URL)
			const lockResponse = await port.sendMessage({
				type: "acquireLock",
				sessionId: sessionIdFromUrl,
				windowId: currentWindowId,
			});

			if (!lockResponse.success) {
				// Session is locked in another window - show landing page instead
				await createAgent();
				if (agent) {
					const welcomeMessage = createWelcomeMessage(tutorials);
					agent.appendMessage(welcomeMessage);
				}
				renderApp();
				return;
			}

			currentSessionId = sessionIdFromUrl;
			const metadata = await storage.sessions.getMetadata(sessionIdFromUrl);
			currentTitle = metadata?.title || "";

			await createAgent({
				systemPrompt: SYSTEM_PROMPT,
				model: sessionData.model,
				thinkingLevel: sessionData.thinkingLevel,
				messages: sessionData.messages,
				tools: [],
			});

			renderApp();
			return;
		} else {
			// Session doesn't exist, redirect to new session
			newSession();
			return;
		}
	}

	// No session - create new agent with welcome message
	await createAgent();

	// Add welcome message for new sessions
	if (agent) {
		const welcomeMessage = createWelcomeMessage(tutorials);
		agent.appendMessage(welcomeMessage);
	}

	renderApp();

	// If no API keys configured, show welcome dialog, open settings, then auto-select model
	if (!(await hasAnyApiKey())) {
		await WelcomeSetupDialog.show();
		await openApiKeysDialog();
		await refreshDiscoveredModels(storage, { wait: true }).catch(() => {});
		await selectDefaultModelForAvailableProvider();
		renderApp();
	}
}

// Register custom user message renderer early, before any session loads
registerUserMessageRenderer();

initApp();
