import { RecordingCoordinator } from "./recording/recording-coordinator.js";
import { RelayBridge } from "./relay/relay-bridge.js";
import {
	getRelayOrchestratorPlan,
	getRelaySessionState,
	setRelayOrchestratorPlan,
	setRelaySessionTabs,
	updateRelayOrchestratorTask,
} from "./relay/relay-orchestrator.js";
import { setupKimiUserAgentHeaderSupport } from "./utils/browser-compat.js";
import type { LockedSessionsMessage, LockResultMessage, SidepanelToBackgroundMessage } from "./utils/port.js";

// Called when Sitegeist icon is clicked - opens sidepanel for current tab
chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
	const tabId = tab?.id;
	if (tabId && chrome.sidePanel.open) {
		chrome.sidePanel.open({ tabId });
	}
});

void setupKimiUserAgentHeaderSupport().then((result) => {
	if (!result.ok) {
		console.warn("[Background] Failed to configure Kimi User-Agent header support:", result.reason);
	}
});

const recordingCoordinator = new RecordingCoordinator();
const relayBridge = new RelayBridge(getRelayHelloPayload, handleRelayRequest, handleRelayStatus);
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
let creatingOffscreenDocument: Promise<void> | null = null;

// Listen for messages from userScripts (overlay in page)
console.log("[Background] onUserScriptMessage available:", !!chrome.runtime.onUserScriptMessage);
if (chrome.runtime.onUserScriptMessage) {
	chrome.runtime.onUserScriptMessage.addListener((message, sender, sendResponse) => {
		console.log("[Background] Received userScript message:", message, "from:", sender);
		if (message.type === "abort-repl") {
			// Forward to all open sidepanels (they'll check if they're streaming)
			console.log("[Background] Relaying abort-repl to sidepanels");
			chrome.runtime.sendMessage(message);
			sendResponse({ success: true });
			return true;
		}
	});
	console.log("[Background] onUserScriptMessage listener registered");
} else {
	console.error("[Background] onUserScriptMessage NOT available!");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.type === "relay_rpc_request") {
		void handleRelayRequest({ method: String(message.method || ""), params: message.params })
			.then((result) => sendResponse({ success: true, result }))
			.catch((error) =>
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error ?? "Relay RPC failed"),
				}),
			);
		return true;
	}
	if (message?.type === "relay_reconfigure") {
		void applyRelayConfig().then(() => sendResponse({ success: true }));
		return true;
	}
	if (message?.type === "relay_run_event") {
		relayBridge.notify("run.event", { runId: message.runId, event: message.event });
		sendResponse({ success: true });
		return true;
	}
	if (message?.type === "relay_run_done") {
		relayBridge.notify("run.done", {
			runId: message.runId,
			status: message.status,
			final: message.final,
			error: message.error,
		});
		sendResponse({ success: true });
		return true;
	}
	if (message?.type === "recording_start") {
		void recordingCoordinator
			.startRecording(message.tabId)
			.then(() => sendResponse({ success: true }))
			.catch((error) =>
				sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
			);
		return true;
	}
	if (message?.type === "recording_stop") {
		void recordingCoordinator.stopRecording().then(() => sendResponse({ success: true }));
		return true;
	}
	if (message?.type === "recording_select_images") {
		void recordingCoordinator
			.selectImages(Array.isArray(message.selectedIds) ? message.selectedIds : [])
			.then((context) => sendResponse({ success: true, context }))
			.catch((error) =>
				sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
			);
		return true;
	}
	if (message?.type === "recording_discard") {
		recordingCoordinator.discard();
		sendResponse({ success: true });
		return true;
	}
	if (message?.type === "recording_event") {
		recordingCoordinator.handleContentEvent(message.event);
		sendResponse({ success: true });
		return true;
	}
});

void applyRelayConfig();
chrome.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local") return;
	if ("relayEnabled" in changes || "relayUrl" in changes || "relayToken" in changes) {
		void applyRelayConfig();
	}
});

// Storage keys for tracking state (persists across service worker sleep)
const SIDEPANEL_OPEN_KEY = "sidepanel_open_windows";
const SESSION_LOCKS_KEY = "session_locks"; // sessionId -> windowId mapping

// Synchronously readable cache of which sidepanels are open
// Gets populated on startup and updated by port events
let openSidepanels = new Set<number>();

// Initialize cache from storage on startup
chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
	openSidepanels = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
	console.log("[Background] Initialized openSidepanels cache:", Array.from(openSidepanels));
});

// Handle port connections from sidepanels
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	// Port name format: "sidepanel:${windowId}"
	const match = /^sidepanel:(\d+)$/.exec(port.name);
	if (!match) return;

	const windowId = Number(match[1]);

	// Update cache synchronously
	openSidepanels.add(windowId);

	// Mark sidepanel as open in persistent storage (survives service worker sleep)
	chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
		const openWindows = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
		openWindows.add(windowId);
		chrome.storage.session.set({ [SIDEPANEL_OPEN_KEY]: Array.from(openWindows) });
	});

	port.onMessage.addListener((msg: SidepanelToBackgroundMessage) => {
		if (msg.type === "acquireLock") {
			const { sessionId, windowId: reqWindowId } = msg;

			// Read current locks from persistent storage
			chrome.storage.session.get(SESSION_LOCKS_KEY, (data) => {
				const sessionLocks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
				const ownerWindowId = sessionLocks[sessionId];
				const ownerSidepanelOpen = ownerWindowId !== undefined && openSidepanels.has(ownerWindowId);

				// Grant lock if: no owner, owner sidepanel closed, or requesting window is owner
				const success = !ownerWindowId || !ownerSidepanelOpen || ownerWindowId === reqWindowId;

				const response: LockResultMessage = success
					? {
							type: "lockResult",
							sessionId,
							success: true,
						}
					: {
							type: "lockResult",
							sessionId,
							success: false,
							ownerWindowId,
						};

				if (success) {
					// Update locks in storage
					sessionLocks[sessionId] = reqWindowId;
					chrome.storage.session.set({ [SESSION_LOCKS_KEY]: sessionLocks });
				}

				port.postMessage(response);
			});
		} else if (msg.type === "getLockedSessions") {
			// Read current locks from persistent storage
			chrome.storage.session.get(SESSION_LOCKS_KEY, (data) => {
				const locks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
				const response: LockedSessionsMessage = {
					type: "lockedSessions",
					locks,
				};
				port.postMessage(response);
			});
		}
	});

	port.onDisconnect.addListener(() => {
		closeSidepanel(windowId, false);
	});
});

// Clean up locks when entire window closes (belt-and-suspenders)
chrome.windows.onRemoved.addListener((windowId: number) => {
	closeSidepanel(windowId, false);
});

// Handle keyboard shortcut - toggle sidepanel open/close
chrome.commands.onCommand.addListener((command: string, sender?: chrome.tabs.Tab) => {
	if (command === "toggle-sidepanel") {
		if (!sender?.windowId) {
			console.log("[Background] Cannot toggle sidepanel: sender windowId not available");
			return;
		}

		const windowId = sender.windowId;

		// Check synchronous cache (populated from storage on startup and updated by port events)
		if (openSidepanels.has(windowId)) {
			// Sidepanel is open - close it using Chrome 141+ API
			closeSidepanel(windowId);
		} else {
			// Sidepanel is closed - open it
			chrome.sidePanel.open({ windowId });
		}
	}
});

function closeSidepanel(windowId: number, callCloseOnSidePanelAPI: boolean = true) {
	if (callCloseOnSidePanelAPI) {
		(chrome.sidePanel as any).close({ windowId });
	}

	// Update cache synchronously
	openSidepanels.delete(windowId);

	// Clean up storage state (same logic as onDisconnect)
	chrome.storage.session.get([SESSION_LOCKS_KEY, SIDEPANEL_OPEN_KEY], (data) => {
		// Release session locks for this window
		const sessionLocks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
		for (const sessionId in sessionLocks) {
			if (sessionLocks[sessionId] === windowId) {
				delete sessionLocks[sessionId];
			}
		}

		// Mark sidepanel as closed
		const openWindows = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
		openWindows.delete(windowId);

		// Save both updates atomically
		chrome.storage.session.set({
			[SESSION_LOCKS_KEY]: sessionLocks,
			[SIDEPANEL_OPEN_KEY]: Array.from(openWindows),
		});
	});
}

async function getRelayHelloPayload() {
	let relayAgentId = "";
	const stored = await chrome.storage.local.get(["relayAgentId"]);
	if (typeof stored.relayAgentId === "string" && stored.relayAgentId) {
		relayAgentId = stored.relayAgentId;
	} else {
		relayAgentId = `sitegeist-${crypto.randomUUID()}`;
		await chrome.storage.local.set({ relayAgentId });
	}

	return {
		agentId: relayAgentId,
		name: "sitegeist-extension",
		version: chrome.runtime.getManifest().version,
		browser: "chrome-extension",
		userAgent: navigator.userAgent,
		capabilities: {
			tools: true,
			agentRun: true,
		},
	};
}

function handleRelayStatus(status: { connected: boolean; lastError?: string | null }) {
	void chrome.storage.local.set({
		relayConnected: Boolean(status.connected),
		relayLastError: status.lastError || "",
		relayLastConnectedAt: status.connected ? Date.now() : undefined,
	});
}

async function applyRelayConfig() {
	const stored = await chrome.storage.local.get(["relayEnabled", "relayUrl", "relayToken"]);
	const enabled = stored.relayEnabled === true || stored.relayEnabled === "true";
	const url = typeof stored.relayUrl === "string" ? stored.relayUrl.trim() : "";
	const token = typeof stored.relayToken === "string" ? stored.relayToken.trim() : "";
	relayBridge.configure({ enabled, url, token });
	if (!enabled) {
		await closeRelayOffscreenDocument();
	}
}

async function handleRelayRequest(request: { method: string; params?: unknown }) {
	switch (request.method) {
		case "tools.list":
			return getRelayTools();
		case "tool.call":
			return await executeRelayTool(request.params);
		case "tabs.list":
			return await listRelayTabs();
		case "session.setTabs":
			return await handleRelaySessionSetTabs(request.params);
		case "session.get":
			return await handleRelaySessionGet(request.params);
		case "orchestrator.plan.set":
			return await handleRelayOrchestratorSet(request.params);
		case "orchestrator.plan.get":
			return await handleRelayOrchestratorGet(request.params);
		case "orchestrator.task.update":
			return await handleRelayOrchestratorTaskUpdate(request.params);
		case "spawn_subagent":
			return await spawnRelaySubagent(request.params);
		case "list_subagents":
		case "subagents.list":
			return await listRelaySubagents(request.params);
		case "await_subagent":
		case "await_agents":
			return await awaitRelaySubagents(request.params);
		case "dispatch_orchestrator_tasks":
			return await dispatchRelayOrchestratorTasks(request.params);
		case "agent.run":
			return await startRelayAgentRun(request.params);
		case "agent.run.stop":
			return await stopRelayAgentRun(request.params);
		case "settings.get":
			return await chrome.storage.local.get(null);
		case "settings.set": {
			const record = asRecord(request.params);
			await chrome.storage.local.set(record || {});
			return { success: true };
		}
		default:
			throw new Error(`Unsupported relay method: ${request.method}`);
	}
}

function getRelayTools() {
	return [
		{ name: "navigate", description: "Navigate the active tab to a URL. Supports { url, newTab }." },
		{ name: "getTabs", description: "List open tabs in the current window." },
		{ name: "listTabs", description: "Alias for getTabs." },
		{ name: "switchTab", description: "Activate a tab by ID. Args: { tabId }." },
		{ name: "activateTab", description: "Alias for switchTab." },
		{ name: "closeTab", description: "Close a tab by ID. Args: { tabId }." },
		{ name: "recording_start", description: "Start recording the active tab." },
		{ name: "recording_stop", description: "Stop the active recording." },
	];
}

async function executeRelayTool(params: unknown) {
	const record = asRecord(params);
	const tool = typeof record?.tool === "string" ? record.tool : "";
	const args = asRecord(record?.args) || {};
	if (!tool) throw new Error("tool.call requires a tool name");

	if (tool === "navigate") {
		const url = typeof args.url === "string" ? args.url : "";
		if (!url) throw new Error("navigate requires args.url");
		return await navigateTab(url, args.newTab === true);
	}
	if (tool === "getTabs" || tool === "listTabs") {
		return await listRelayTabs();
	}
	if (tool === "switchTab" || tool === "activateTab") {
		const tabId = Number(args.tabId);
		if (!Number.isFinite(tabId)) throw new Error("switchTab requires numeric tabId");
		await chrome.tabs.update(tabId, { active: true });
		return { success: true, tabId };
	}
	if (tool === "closeTab") {
		const tabId = Number(args.tabId);
		if (!Number.isFinite(tabId)) throw new Error("closeTab requires numeric tabId");
		await chrome.tabs.remove(tabId);
		return { success: true, tabId };
	}
	if (tool === "recording_start") {
		await recordingCoordinator.startRecording();
		return { success: true };
	}
	if (tool === "recording_stop") {
		await recordingCoordinator.stopRecording();
		return { success: true };
	}

	throw new Error(`Unsupported relay tool: ${tool}`);
}

async function navigateTab(url: string, newTab: boolean) {
	if (newTab) {
		const tab = await chrome.tabs.create({ url, active: true });
		return { success: true, tabId: tab.id, finalUrl: tab.url || url, title: tab.title || "Untitled" };
	}

	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) throw new Error("No active tab found");
	await chrome.tabs.update(tab.id, { url });
	return await new Promise((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			chrome.tabs.onUpdated.removeListener(listener);
			reject(new Error("Navigation timed out"));
		}, 30_000);
		const listener = (tabId: number, changeInfo: { status?: string }, updatedTab: chrome.tabs.Tab) => {
			if (tabId !== tab.id || changeInfo.status !== "complete") return;
			clearTimeout(timeoutId);
			chrome.tabs.onUpdated.removeListener(listener);
			resolve({
				success: true,
				tabId,
				finalUrl: updatedTab.url || url,
				title: updatedTab.title || "Untitled",
			});
		};
		chrome.tabs.onUpdated.addListener(listener);
	});
}

async function startRelayAgentRun(params: unknown) {
	const { prompt, sessionId, selectedTabIds } = await validateRelayRunParams(params);
	const runId = crypto.randomUUID();
	await ensureRelayOffscreenDocument();
	const accepted = await chrome.runtime.sendMessage({
		type: "relay_offscreen_run",
		runId,
		prompt,
		selectedTabIds,
		sessionId,
	});
	if (!accepted?.success) {
		throw new Error(accepted?.error || "No relay offscreen agent accepted the relay run");
	}
	return { runId, sessionId: accepted.sessionId || sessionId || undefined };
}

async function stopRelayAgentRun(params: unknown) {
	const record = asRecord(params);
	const runId = typeof record?.runId === "string" ? record.runId.trim() : "";
	if (!runId) throw new Error("agent.run.stop requires runId");
	await ensureRelayOffscreenDocument();
	const response = await chrome.runtime.sendMessage({
		type: "relay_offscreen_abort",
		runId,
	});
	return { success: response?.success === true || response?.stopped === true, runId };
}

async function spawnRelaySubagent(params: unknown) {
	const record = asRecord(params);
	const prompt = typeof record?.prompt === "string" ? record.prompt.trim() : "";
	if (!prompt) throw new Error("spawn_subagent requires prompt");
	const sessionId = record?.sessionId !== undefined ? normalizeRelaySessionId(record.sessionId) : undefined;
	const selectedTabId =
		typeof record?.selectedTabId === "number" && Number.isInteger(record.selectedTabId)
			? record.selectedTabId
			: undefined;
	await ensureRelayOffscreenDocument();
	const response = await chrome.runtime.sendMessage({
		type: "relay_offscreen_spawn_subagent",
		subagentId: typeof record?.subagentId === "string" ? record.subagentId : undefined,
		parentRunId: typeof record?.parentRunId === "string" ? record.parentRunId : undefined,
		sessionId,
		taskId: typeof record?.taskId === "string" ? record.taskId : undefined,
		prompt,
		selectedTabId,
	});
	return response?.subagent || response;
}

async function listRelaySubagents(params: unknown) {
	const record = asRecord(params);
	const sessionId = record?.sessionId !== undefined ? normalizeRelaySessionId(record.sessionId) : undefined;
	await ensureRelayOffscreenDocument();
	const response = await chrome.runtime.sendMessage({
		type: "relay_offscreen_list_subagents",
		sessionId,
	});
	return response?.subagents || [];
}

async function awaitRelaySubagents(params: unknown) {
	const record = asRecord(params);
	const subagentIds = Array.isArray(record?.subagentIds)
		? record.subagentIds.map((entry) => String(entry || "").trim()).filter(Boolean)
		: typeof record?.subagentId === "string" && record.subagentId.trim()
			? [record.subagentId.trim()]
			: [];
	if (subagentIds.length === 0) {
		throw new Error("await_subagent requires subagentId or subagentIds");
	}
	const timeoutMs = typeof record?.timeoutMs === "number" ? record.timeoutMs : 600_000;
	await ensureRelayOffscreenDocument();
	const response = await chrome.runtime.sendMessage({
		type: "relay_offscreen_await_subagent",
		subagentIds,
		timeoutMs,
	});
	return response?.subagents || [];
}

async function dispatchRelayOrchestratorTasks(params: unknown) {
	const record = asRecord(params);
	const sessionId = normalizeRelaySessionId(record?.sessionId);
	const maxTasks = typeof record?.maxTasks === "number" ? record.maxTasks : undefined;
	await ensureRelayOffscreenDocument();
	return await chrome.runtime.sendMessage({
		type: "relay_offscreen_dispatch_tasks",
		sessionId,
		maxTasks,
	});
}

function asRecord(value: unknown): Record<string, any> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, any>;
}

async function listRelayTabs() {
	const tabs = await chrome.tabs.query({ currentWindow: true });
	return tabs
		.filter((tab) => typeof tab.id === "number")
		.map((tab) => ({
			id: tab.id,
			windowId: tab.windowId,
			title: tab.title || "Untitled",
			url: tab.url || "",
			active: tab.active === true,
		}));
}

function normalizeRelaySessionId(value: unknown): string {
	const sessionId = typeof value === "string" ? value.trim() : "";
	if (!sessionId) throw new Error("sessionId must be a non-empty string");
	if (sessionId.length > 120) throw new Error("sessionId too long (max 120 chars)");
	if (!/^[A-Za-z0-9._:-]+$/.test(sessionId)) {
		throw new Error("sessionId contains invalid characters");
	}
	return sessionId;
}

function normalizeSelectedTabIds(value: unknown): number[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error("selectedTabIds must be an array when provided");
	}
	if (value.length > 25) {
		throw new Error("selectedTabIds supports at most 25 tabs");
	}
	const selectedTabIds = value.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry > 0);
	if (value.length > 0 && selectedTabIds.length === 0) {
		throw new Error("selectedTabIds must contain positive integer tab IDs");
	}
	return selectedTabIds;
}

async function validateRelayRunParams(params: unknown) {
	const record = asRecord(params);
	const prompt = typeof record?.prompt === "string" ? record.prompt.trim() : "";
	if (!prompt) throw new Error("agent.run requires prompt");
	if (prompt.length > 20_000) throw new Error("agent.run prompt too large (max 20,000 chars)");

	const sessionId = record?.sessionId !== undefined ? normalizeRelaySessionId(record.sessionId) : undefined;
	let selectedTabIds = normalizeSelectedTabIds(record?.selectedTabIds);

	if (sessionId && selectedTabIds.length === 0) {
		const sessionState = await getRelaySessionState(sessionId);
		selectedTabIds = sessionState.selectedTabIds;
	}

	return { prompt, sessionId, selectedTabIds };
}

async function handleRelaySessionSetTabs(params: unknown) {
	const record = asRecord(params);
	const sessionId = normalizeRelaySessionId(record?.sessionId);
	const selectedTabIds = normalizeSelectedTabIds(record?.selectedTabIds);
	const state = await setRelaySessionTabs(sessionId, selectedTabIds);
	return {
		sessionId: state.sessionId,
		selectedTabIds: state.selectedTabIds,
		updatedAt: state.updatedAt,
	};
}

async function handleRelaySessionGet(params: unknown) {
	const record = asRecord(params);
	const sessionId = normalizeRelaySessionId(record?.sessionId);
	const state = await getRelaySessionState(sessionId);
	return {
		sessionId: state.sessionId,
		selectedTabIds: state.selectedTabIds,
		hasOrchestratorPlan: Boolean(state.orchestratorPlan),
		updatedAt: state.updatedAt,
	};
}

async function handleRelayOrchestratorSet(params: unknown) {
	const record = asRecord(params);
	const sessionId = normalizeRelaySessionId(record?.sessionId);
	return await setRelayOrchestratorPlan(sessionId, record?.plan);
}

async function handleRelayOrchestratorGet(params: unknown) {
	const record = asRecord(params);
	const sessionId = normalizeRelaySessionId(record?.sessionId);
	return await getRelayOrchestratorPlan(sessionId);
}

async function handleRelayOrchestratorTaskUpdate(params: unknown) {
	const record = asRecord(params);
	const sessionId = normalizeRelaySessionId(record?.sessionId);
	return await updateRelayOrchestratorTask(sessionId, record);
}

async function ensureRelayOffscreenDocument() {
	const contexts = await chrome.runtime.getContexts({
		contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
		documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
	});
	if (contexts.length > 0) return;
	if (!creatingOffscreenDocument) {
		creatingOffscreenDocument = chrome.offscreen
			.createDocument({
				url: OFFSCREEN_DOCUMENT_PATH,
				reasons: [chrome.offscreen.Reason.IFRAME_SCRIPTING, chrome.offscreen.Reason.BLOBS],
				justification: "Run the relay agent and sandbox-backed tools without requiring an open sidepanel.",
			})
			.finally(() => {
				creatingOffscreenDocument = null;
			});
	}
	await creatingOffscreenDocument;
}

async function closeRelayOffscreenDocument() {
	const contexts = await chrome.runtime.getContexts({
		contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
		documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
	});
	if (contexts.length === 0) return;
	await chrome.offscreen.closeDocument();
}
