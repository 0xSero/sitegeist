import {
	type AfterToolCallContext,
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type BeforeToolCallContext,
} from "@mariozechner/pi-agent-core";
import { createStreamFn, setAppStorage } from "@mariozechner/pi-web-ui";
import type { OrchestratorTaskNode } from "@sitegeist/shared";
import { browserMessageTransformer } from "../messages/message-transformer.js";
import { createNavigationMessage, type NavigationMessage } from "../messages/NavigationMessage.js";
import { resolveApiKey } from "../oauth/index.js";
import { SYSTEM_PROMPT } from "../prompts/prompts.js";
import { getRelayOrchestratorPlan, updateRelayOrchestratorTask } from "../relay/relay-orchestrator.js";
import { SitegeistAppStorage } from "../storage/app-storage.js";
import { initializeDefaultSkills } from "../tools/skill.js";
import { resolveDefaultModel } from "./model-defaults.js";
import { createSitegeistTools } from "./tool-factory.js";

type RunKind = "main" | "subagent";
type RunDoneStatus = "completed" | "failed" | "stopped";

export type StartMainRunInput = {
	runId: string;
	prompt: string;
	selectedTabIds: number[];
	sessionId?: string;
};

export type SpawnSubagentInput = {
	subagentId?: string;
	parentRunId?: string;
	sessionId?: string;
	taskId?: string;
	prompt: string;
	selectedTabId?: number;
};

export type ManagedRunSummary = {
	runId: string;
	subagentId?: string;
	kind: RunKind;
	status: "running" | RunDoneStatus;
	sessionId?: string;
	parentRunId?: string;
	taskId?: string;
	selectedTabIds: number[];
	primaryTabId?: number;
	windowId: number;
	createdAt: number;
	updatedAt: number;
	done?: {
		status: RunDoneStatus;
		final?: unknown;
		error?: string;
		summary?: string;
	};
};

type ManagedRun = ManagedRunSummary & {
	agent: Agent;
	stopRequested: boolean;
	persistSession: boolean;
	storageSessionId?: string;
	currentTitle: string;
	recordedCostMessages: Set<AgentMessage>;
	unsubscribe?: () => void;
	resolveDone: (value: RunCompletion) => void;
	donePromise: Promise<RunCompletion>;
	browserLockRelease?: () => void;
};

type RunCompletion = NonNullable<ManagedRunSummary["done"]>;

type OffscreenRunEventEmitter = (payload: {
	runId: string;
	event?: unknown;
	status?: RunDoneStatus;
	final?: unknown;
	error?: string;
	sessionId?: string;
}) => Promise<void>;

class AsyncLock {
	private holder: string | null = null;
	private queue: Array<{
		token: string;
		resolve: (release: () => void) => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
		cleanupAbort?: () => void;
	}> = [];

	async acquire(token: string, signal?: AbortSignal): Promise<() => void> {
		if (!this.holder) {
			this.holder = token;
			return this.createRelease(token);
		}

		return await new Promise<() => void>((resolve, reject) => {
			const waiter = {
				token,
				resolve,
				reject,
				signal,
				cleanupAbort: undefined as (() => void) | undefined,
			};
			if (signal) {
				const onAbort = () => {
					this.queue = this.queue.filter((entry) => entry !== waiter);
					reject(new Error("Execution aborted"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				waiter.cleanupAbort = () => signal.removeEventListener("abort", onAbort);
			}
			this.queue.push(waiter);
		});
	}

	private createRelease(token: string) {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (this.holder === token) {
				this.holder = null;
			}
			while (this.queue.length > 0 && !this.holder) {
				const next = this.queue.shift();
				if (!next) break;
				next.cleanupAbort?.();
				if (next.signal?.aborted) {
					next.reject(new Error("Execution aborted"));
					continue;
				}
				this.holder = next.token;
				next.resolve(this.createRelease(next.token));
				break;
			}
		};
	}
}

export class RelayRunManager {
	private readonly storage = new SitegeistAppStorage();
	private readonly runs = new Map<string, ManagedRun>();
	private readonly subagentIds = new Map<string, string>();
	private readonly tabLeases = new Map<number, string>();
	private readonly browserLock = new AsyncLock();
	private initialized = false;

	constructor(private readonly emitRunState: OffscreenRunEventEmitter) {
		setAppStorage(this.storage);
	}

	async initialize() {
		if (this.initialized) return;
		await initializeDefaultSkills();
		this.initialized = true;
	}

	async startMainRun(input: StartMainRunInput): Promise<{ runId: string; sessionId: string }> {
		await this.initialize();
		const sessionId = input.sessionId?.trim() || `relay-${crypto.randomUUID()}`;
		if (this.hasActivePersistentRun(sessionId)) {
			throw new Error(`A relay run is already active for session ${sessionId}`);
		}

		const resolved = await this.resolveRunTarget(input.selectedTabIds);
		const loaded = await this.storage.sessions.loadSession(sessionId);
		const initialState = loaded
			? {
					systemPrompt: SYSTEM_PROMPT,
					model: loaded.model,
					thinkingLevel: loaded.thinkingLevel,
					messages: loaded.messages,
					tools: [],
				}
			: undefined;

		const run = await this.createRun({
			runId: input.runId,
			kind: "main",
			sessionId,
			persistSession: true,
			storageSessionId: sessionId,
			selectedTabIds: resolved.selectedTabIds,
			primaryTabId: resolved.primaryTabId,
			windowId: resolved.windowId,
			initialState,
		});

		void this.executeRun(run, input.prompt);
		return { runId: run.runId, sessionId };
	}

	async stopRun(runId: string): Promise<boolean> {
		const run = this.runs.get(runId);
		if (!run) return false;
		run.stopRequested = true;
		run.agent.abort();
		return true;
	}

	async spawnSubagent(input: SpawnSubagentInput): Promise<ManagedRunSummary> {
		await this.initialize();
		const subagentId = input.subagentId?.trim() || `subagent-${crypto.randomUUID()}`;
		if (this.subagentIds.has(subagentId)) {
			throw new Error(`Subagent already exists: ${subagentId}`);
		}

		const preferredTabIds =
			typeof input.selectedTabId === "number" && Number.isInteger(input.selectedTabId) ? [input.selectedTabId] : [];
		const resolved = await this.resolveRunTarget(preferredTabIds);
		const runId = `subrun-${crypto.randomUUID()}`;
		const run = await this.createRun({
			runId,
			subagentId,
			kind: "subagent",
			sessionId: input.sessionId,
			parentRunId: input.parentRunId,
			taskId: input.taskId,
			persistSession: false,
			selectedTabIds: resolved.selectedTabIds,
			primaryTabId: resolved.primaryTabId,
			windowId: resolved.windowId,
		});
		this.subagentIds.set(subagentId, runId);

		if (run.taskId && run.sessionId) {
			await updateRelayOrchestratorTask(run.sessionId, {
				taskId: run.taskId,
				status: "running",
				assignedTabId: run.primaryTabId,
				notes: `Dispatched to ${subagentId}`,
			});
		}

		void this.executeRun(run, input.prompt);
		return this.toSummary(run);
	}

	listSubagents(sessionId?: string): ManagedRunSummary[] {
		return Array.from(this.runs.values())
			.filter((run) => run.kind === "subagent")
			.filter((run) => !sessionId || run.sessionId === sessionId)
			.map((run) => this.toSummary(run));
	}

	async awaitSubagents(subagentIds: string[], timeoutMs: number): Promise<ManagedRunSummary[]> {
		const runs = subagentIds.map((subagentId) => {
			const runId = this.subagentIds.get(subagentId);
			if (!runId) throw new Error(`Unknown subagent: ${subagentId}`);
			const run = this.runs.get(runId);
			if (!run) throw new Error(`Unknown subagent run: ${subagentId}`);
			return run;
		});

		await this.waitForRuns(runs, timeoutMs);
		return runs.map((run) => this.toSummary(run));
	}

	async dispatchOrchestratorTasks(
		sessionId: string,
		maxTasks?: number,
	): Promise<{
		sessionId: string;
		started: ManagedRunSummary[];
		plan: Awaited<ReturnType<typeof getRelayOrchestratorPlan>>;
	}> {
		const planSnapshot = await getRelayOrchestratorPlan(sessionId);
		if (!planSnapshot.plan) {
			throw new Error("No orchestrator plan exists for this session.");
		}

		const runningTabIds = new Set(
			this.listSubagents(sessionId)
				.filter((entry) => entry.status === "running")
				.map((entry) => entry.primaryTabId)
				.filter((entry): entry is number => typeof entry === "number"),
		);
		const availableTabs = planSnapshot.selectedTabIds.filter((tabId) => !runningTabIds.has(tabId));
		const dispatchableTasks = planSnapshot.dispatchableTaskIds
			.map((taskId) => planSnapshot.plan?.tasks.find((task) => task.id === taskId))
			.filter((task): task is NonNullable<typeof task> => Boolean(task));
		const limit = Math.max(1, Math.min(maxTasks ?? (dispatchableTasks.length || 1), availableTabs.length));

		const started: ManagedRunSummary[] = [];
		for (let index = 0; index < dispatchableTasks.length && started.length < limit; index += 1) {
			const task = dispatchableTasks[index];
			const leasedTabId =
				task.assignedTabId && !runningTabIds.has(task.assignedTabId) ? task.assignedTabId : availableTabs.shift();
			if (!leasedTabId) break;
			const prompt = buildSubagentPrompt(planSnapshot.plan.goal, task);
			const startedRun = await this.spawnSubagent({
				sessionId,
				taskId: task.id,
				prompt,
				selectedTabId: leasedTabId,
			});
			started.push(startedRun);
			runningTabIds.add(leasedTabId);
		}

		return {
			sessionId,
			started,
			plan: await getRelayOrchestratorPlan(sessionId),
		};
	}

	private hasActivePersistentRun(sessionId: string): boolean {
		return Array.from(this.runs.values()).some(
			(run) =>
				run.kind === "main" &&
				run.persistSession &&
				run.storageSessionId === sessionId &&
				(!run.done || run.status === "running"),
		);
	}

	private async resolveRunTarget(preferredTabIds: number[]): Promise<{
		selectedTabIds: number[];
		primaryTabId?: number;
		windowId: number;
	}> {
		let selectedTabIds = preferredTabIds.filter((entry) => Number.isInteger(entry) && entry > 0);
		let primaryTabId = selectedTabIds[0];
		let windowId: number | undefined;

		if (primaryTabId) {
			const tab = await chrome.tabs.get(primaryTabId);
			windowId = tab.windowId;
		}

		if (!windowId) {
			const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
			if (!tab?.id || typeof tab.windowId !== "number") {
				throw new Error("Unable to resolve an active browser tab for this run");
			}
			primaryTabId = tab.id;
			windowId = tab.windowId;
			if (selectedTabIds.length === 0) {
				selectedTabIds = [tab.id];
			}
		}

		return { selectedTabIds, primaryTabId, windowId };
	}

	private async createRun(config: {
		runId: string;
		subagentId?: string;
		kind: RunKind;
		sessionId?: string;
		parentRunId?: string;
		taskId?: string;
		persistSession: boolean;
		storageSessionId?: string;
		selectedTabIds: number[];
		primaryTabId?: number;
		windowId: number;
		initialState?: Partial<AgentState>;
	}): Promise<ManagedRun> {
		for (const tabId of config.selectedTabIds) {
			this.leaseTab(config.runId, tabId);
		}

		const runBase: Omit<ManagedRun, "agent" | "resolveDone" | "donePromise"> = {
			runId: config.runId,
			subagentId: config.subagentId,
			kind: config.kind,
			status: "running",
			sessionId: config.sessionId,
			parentRunId: config.parentRunId,
			taskId: config.taskId,
			selectedTabIds: [...config.selectedTabIds],
			primaryTabId: config.primaryTabId,
			windowId: config.windowId,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			done: undefined,
			stopRequested: false,
			persistSession: config.persistSession,
			storageSessionId: config.storageSessionId,
			currentTitle: config.initialState?.messages ? generateTitle(config.initialState.messages) : "",
			recordedCostMessages: new Set<AgentMessage>(),
			unsubscribe: undefined,
			browserLockRelease: undefined,
		};

		for (const message of config.initialState?.messages || []) {
			if (message.role === "assistant" && message.usage?.cost?.total > 0) {
				runBase.recordedCostMessages.add(message);
			}
		}

		let resolveDone: (value: RunCompletion) => void = () => {};
		const donePromise = new Promise<RunCompletion>((resolve) => {
			resolveDone = resolve;
		});

		const run = {
			...runBase,
			resolveDone,
			donePromise,
			agent: await this.createAgentForRun(runBase, config.initialState),
		} satisfies ManagedRun;

		run.agent.sessionId = run.storageSessionId;
		run.unsubscribe = run.agent.subscribe((event) => {
			void this.handleAgentEvent(run.runId, event);
		});
		this.runs.set(run.runId, run);
		return run;
	}

	private async createAgentForRun(
		run: Pick<ManagedRun, "runId" | "windowId" | "storageSessionId" | "persistSession" | "sessionId">,
		initialState?: Partial<AgentState>,
	): Promise<Agent> {
		const stored = await chrome.storage.local.get("debuggerMode");
		const debuggerModeEnabled = stored.debuggerMode === true;
		const corsProxyEnabled = (await this.storage.settings.get<boolean>("proxy.enabled")) === true;
		const corsProxyUrl = (await this.storage.settings.get<string>("proxy.url")) || undefined;
		const defaultModel = await resolveDefaultModel(this.storage, initialState?.model);

		const agent = new Agent({
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
				const enabled = await this.storage.settings.get<boolean>("proxy.enabled");
				if (!enabled) return undefined;
				return (await this.storage.settings.get<string>("proxy.url")) || undefined;
			}),
			getApiKey: async (provider: string) => {
				const storedProviderKey = await this.storage.providerKeys.get(provider);
				if (!storedProviderKey) return undefined;
				const proxyEnabled = await this.storage.settings.get<boolean>("proxy.enabled");
				const proxyUrl = proxyEnabled
					? (await this.storage.settings.get<string>("proxy.url")) || undefined
					: undefined;
				return resolveApiKey(storedProviderKey, provider, this.storage.providerKeys, proxyUrl);
			},
			beforeToolCall: async (context, signal) => {
				await this.beforeToolCall(run.runId, context, signal);
				return undefined;
			},
			afterToolCall: async (context) => {
				await this.afterToolCall(run.runId, context);
				return undefined;
			},
		});

		agent.setTools(
			createSitegeistTools({
				currentWindowId: run.windowId,
				debuggerModeEnabled,
				corsProxyEnabled,
				corsProxyUrl,
				sandboxUrlProvider: () => chrome.runtime.getURL("sandbox.html"),
				ensureSessionId: async () => run.sessionId || run.storageSessionId || `subagent-${run.runId}`,
			}),
		);
		return agent;
	}

	private async beforeToolCall(runId: string, _context: BeforeToolCallContext, signal?: AbortSignal) {
		const run = this.runs.get(runId);
		if (!run) return;
		run.browserLockRelease = await this.browserLock.acquire(runId, signal);
		const tabId = await this.ensurePrimaryTab(run);
		if (!tabId) return;
		try {
			await chrome.windows.update(run.windowId, { focused: true });
		} catch {}
		await chrome.tabs.update(tabId, { active: true });
	}

	private async afterToolCall(runId: string, context: AfterToolCallContext) {
		const run = this.runs.get(runId);
		if (!run) return;
		try {
			const details = asRecord(context.result.details);
			const nextTabId =
				typeof details?.tabId === "number" && Number.isInteger(details.tabId) ? details.tabId : undefined;
			if (nextTabId) {
				await this.tryMovePrimaryLease(run, nextTabId);
			}
		} finally {
			run.browserLockRelease?.();
			run.browserLockRelease = undefined;
		}
	}

	private async ensurePrimaryTab(run: ManagedRun): Promise<number | undefined> {
		if (typeof run.primaryTabId === "number") return run.primaryTabId;
		const [tab] = await chrome.tabs.query({ active: true, windowId: run.windowId });
		if (!tab?.id) return undefined;
		this.leaseTab(run.runId, tab.id);
		run.primaryTabId = tab.id;
		if (!run.selectedTabIds.includes(tab.id)) run.selectedTabIds.push(tab.id);
		return run.primaryTabId;
	}

	private async tryMovePrimaryLease(run: ManagedRun, nextTabId: number) {
		if (run.primaryTabId === nextTabId) return;
		const existingOwner = this.tabLeases.get(nextTabId);
		if (existingOwner && existingOwner !== run.runId) return;
		this.leaseTab(run.runId, nextTabId);
		run.primaryTabId = nextTabId;
		if (!run.selectedTabIds.includes(nextTabId)) run.selectedTabIds.push(nextTabId);
		const tab = await chrome.tabs.get(nextTabId);
		run.windowId = tab.windowId;
	}

	private async executeRun(run: ManagedRun, prompt: string) {
		run.updatedAt = Date.now();
		try {
			await this.appendNavigationContext(run);
			await this.emitRunState({
				runId: run.runId,
				event: {
					type: "started",
					kind: run.kind,
					subagentId: run.subagentId,
					selectedTabIds: run.selectedTabIds,
					sessionId: run.sessionId,
				},
				sessionId: run.sessionId,
			});
			await run.agent.prompt(prompt);
			const final = getLastAssistantContent(run.agent.state.messages);
			await this.finishRun(run.runId, {
				status: run.stopRequested ? "stopped" : "completed",
				final,
				summary: summarizeAssistantContent(final),
			});
		} catch (error) {
			await this.finishRun(run.runId, {
				status: run.stopRequested ? "stopped" : "failed",
				error: error instanceof Error ? error.message : String(error ?? "Run failed"),
			});
		}
	}

	private async finishRun(runId: string, done: RunCompletion) {
		const run = this.runs.get(runId);
		if (!run || run.done) return;

		run.done = done;
		run.status = done.status;
		run.updatedAt = Date.now();
		run.browserLockRelease?.();
		run.browserLockRelease = undefined;
		run.resolveDone(done);

		if (run.taskId && run.sessionId) {
			await updateRelayOrchestratorTask(run.sessionId, {
				taskId: run.taskId,
				status: done.status === "completed" ? "completed" : done.status === "stopped" ? "cancelled" : "failed",
				assignedTabId: run.primaryTabId,
				summary: done.summary,
				notes: done.error || done.summary,
			});
		}

		await this.emitRunState({
			runId,
			status: done.status,
			final: done.final,
			error: done.error,
			sessionId: run.sessionId,
		});

		run.unsubscribe?.();
		this.releaseRunLeases(runId);
		if (run.subagentId) {
			this.subagentIds.set(run.subagentId, runId);
		}
	}

	private async appendNavigationContext(run: ManagedRun) {
		const tabId = await this.ensurePrimaryTab(run);
		if (!tabId) return;
		const tab = await chrome.tabs.get(tabId);
		if (!tab.url || tab.url.startsWith("chrome-extension://")) return;

		let lastUrl: string | undefined;
		for (let i = run.agent.state.messages.length - 1; i >= 0; i -= 1) {
			const message = run.agent.state.messages[i];
			if (message.role === "navigation") {
				lastUrl = (message as NavigationMessage).url;
				break;
			}
			if (message.role === "toolResult") {
				const maybeNavigate = message as { toolName?: string; details?: { finalUrl?: string } };
				if (maybeNavigate.toolName === "navigate") {
					lastUrl = maybeNavigate.details?.finalUrl;
					break;
				}
			}
		}
		if (lastUrl === tab.url) return;
		run.agent.appendMessage(await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id));
	}

	private async handleAgentEvent(runId: string, event: AgentEvent) {
		const run = this.runs.get(runId);
		if (!run) return;

		this.storage.settings
			.set("lastUsedModel", run.agent.state.model)
			.catch((error) => console.error("[Offscreen] Failed to save lastUsedModel:", error));

		if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage?.cost?.total > 0) {
			if (!run.recordedCostMessages.has(event.message)) {
				run.recordedCostMessages.add(event.message);
				this.storage.costs
					.recordCost(run.agent.state.model.provider, run.agent.state.model.id, event.message.usage.cost.total)
					.catch((error) => console.error("[Offscreen] Failed to record cost:", error));
			}
		}

		if (event.type === "tool_execution_start") {
			await this.emitRunState({
				runId,
				event: {
					type: "tool_execution_start",
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					subagentId: run.subagentId,
				},
				sessionId: run.sessionId,
			});
		}

		if (event.type === "tool_execution_end") {
			await this.emitRunState({
				runId,
				event: {
					type: "tool_execution_end",
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					isError: event.isError,
					subagentId: run.subagentId,
				},
				sessionId: run.sessionId,
			});
		}

		if (!run.persistSession) return;

		if (!run.currentTitle && shouldSaveSession(run.agent.state.messages)) {
			run.currentTitle = generateTitle(run.agent.state.messages);
		}
		if (run.storageSessionId && shouldSaveSession(run.agent.state.messages)) {
			await saveSession(this.storage, run.storageSessionId, run.agent.state, run.currentTitle);
		}
	}

	private leaseTab(runId: string, tabId: number) {
		const owner = this.tabLeases.get(tabId);
		if (owner && owner !== runId) {
			throw new Error(`Tab ${tabId} is already leased by another run`);
		}
		this.tabLeases.set(tabId, runId);
	}

	private releaseRunLeases(runId: string) {
		for (const [tabId, owner] of this.tabLeases.entries()) {
			if (owner === runId) this.tabLeases.delete(tabId);
		}
	}

	private async waitForRuns(runs: ManagedRun[], timeoutMs: number) {
		const timeout = Math.max(1000, timeoutMs || 600_000);
		await Promise.race([
			Promise.all(runs.map((run) => run.donePromise)),
			new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for subagent")), timeout)),
		]);
	}

	private toSummary(run: ManagedRun): ManagedRunSummary {
		return {
			runId: run.runId,
			subagentId: run.subagentId,
			kind: run.kind,
			status: run.status,
			sessionId: run.sessionId,
			parentRunId: run.parentRunId,
			taskId: run.taskId,
			selectedTabIds: [...run.selectedTabIds],
			primaryTabId: run.primaryTabId,
			windowId: run.windowId,
			createdAt: run.createdAt,
			updatedAt: run.updatedAt,
			done: run.done,
		};
	}
}

function buildSubagentPrompt(goal: string, task: OrchestratorTaskNode) {
	const inputs = task.inputs
		.map((entry) => `- ${entry.key}${entry.description ? `: ${entry.description}` : ""}`)
		.join("\n");
	const outputs = task.outputs
		.map((entry) => `- ${entry.key}${entry.description ? `: ${entry.description}` : ""}`)
		.join("\n");
	const validations = task.validations
		.map(
			(entry) =>
				`- ${entry.kind}${entry.value ? `: ${entry.value}` : ""}${entry.selector ? ` (${entry.selector})` : ""}`,
		)
		.join("\n");
	return [
		`Goal: ${goal}`,
		`Task: ${task.title}`,
		task.summary ? `Summary: ${task.summary}` : "",
		task.prompt ? `Task Prompt: ${task.prompt}` : "",
		inputs ? `Required Inputs:\n${inputs}` : "",
		outputs ? `Expected Outputs:\n${outputs}` : "",
		validations ? `Validations:\n${validations}` : "",
		"Work only on this task. Use the available browser tools. Finish with a concise result summary.",
	]
		.filter(Boolean)
		.join("\n\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function shouldSaveSession(messages: AgentMessage[]): boolean {
	const hasUser = messages.some((message) => message.role === "user");
	const hasAssistant = messages.some((message) => message.role === "assistant");
	return hasUser && hasAssistant;
}

function generateTitle(messages: AgentMessage[]): string {
	const firstUserMsg = messages.find((message) => message.role === "user");
	if (!firstUserMsg || firstUserMsg.role !== "user") return "";
	const text =
		typeof firstUserMsg.content === "string"
			? firstUserMsg.content
			: firstUserMsg.content
					.filter((entry) => entry.type === "text")
					.map((entry) => entry.text || "")
					.join(" ");
	const trimmed = text.trim();
	if (!trimmed) return "";
	const sentenceEnd = trimmed.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) return trimmed.substring(0, sentenceEnd + 1);
	return trimmed.length <= 50 ? trimmed : `${trimmed.substring(0, 47)}...`;
}

function getLastAssistantContent(messages: AgentMessage[]): unknown {
	const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
	return lastAssistant?.content || null;
}

function summarizeAssistantContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((entry): entry is { type: string; text?: string; thinking?: string } =>
			Boolean(entry && typeof entry === "object"),
		)
		.map((entry) => {
			if (entry.type === "text") return entry.text || "";
			if (entry.type === "thinking") return entry.thinking || "";
			return "";
		})
		.join("\n")
		.trim();
	return text ? text.slice(0, 2000) : undefined;
}

async function saveSession(
	storage: SitegeistAppStorage,
	sessionId: string,
	state: AgentState,
	title: string,
): Promise<void> {
	if (!title) return;

	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	for (const message of state.messages) {
		if (message.role !== "assistant") continue;
		usage.input += message.usage.input;
		usage.output += message.usage.output;
		usage.cacheRead += message.usage.cacheRead;
		usage.cacheWrite += message.usage.cacheWrite;
		usage.totalTokens +=
			message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
		if (message.usage.cost) {
			usage.cost.input += message.usage.cost.input;
			usage.cost.output += message.usage.cost.output;
			usage.cost.cacheRead += message.usage.cost.cacheRead;
			usage.cost.cacheWrite += message.usage.cost.cacheWrite;
			usage.cost.total += message.usage.cost.total;
		}
	}

	let preview = "";
	for (const message of state.messages) {
		if (preview.length >= 2048) break;
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((entry) => entry.type === "text")
							.map((entry) => entry.text)
							.join("\n");
			preview += `${text}\n`;
			continue;
		}
		if (message.role === "assistant") {
			const text = message.content
				.filter((entry) => entry.type === "text" || entry.type === "thinking")
				.map((entry) => (entry.type === "text" ? entry.text : entry.thinking))
				.join("\n");
			preview += `${text}\n`;
		}
	}

	const existingMetadata = await storage.sessions.getMetadata(sessionId);
	const metadata = {
		id: sessionId,
		title,
		createdAt: existingMetadata?.createdAt || new Date().toISOString(),
		lastModified: new Date().toISOString(),
		messageCount: state.messages.length,
		usage,
		modelId: state.model.id,
		thinkingLevel: state.thinkingLevel,
		preview: preview.substring(0, 2048),
	};
	await storage.sessions.saveSession(sessionId, state, metadata, title);
}
