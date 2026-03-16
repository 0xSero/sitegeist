import {
	buildOrchestratorPlan,
	getDispatchableOrchestratorTaskIds,
	getOrchestratorPlanValidationIssues,
	getReadyOrchestratorTaskIds,
	normalizeOrchestratorTaskStatus,
	type OrchestratorPlan,
	type OrchestratorTaskNode,
} from "@sitegeist/shared";

const RELAY_SESSION_STATE_KEY = "relay_session_state_v1";

export type RelaySessionState = {
	sessionId: string;
	selectedTabIds: number[];
	orchestratorPlan: OrchestratorPlan | null;
	updatedAt: number;
};

type RelaySessionStateMap = Record<string, RelaySessionState>;

type RelayPlanSnapshot = {
	sessionId: string;
	selectedTabIds: number[];
	plan: OrchestratorPlan | null;
	readyTaskIds: string[];
	dispatchableTaskIds: string[];
	validationIssues: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function sanitizeTabIds(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry > 0);
}

function defaultRelaySessionState(sessionId: string): RelaySessionState {
	return {
		sessionId,
		selectedTabIds: [],
		orchestratorPlan: null,
		updatedAt: Date.now(),
	};
}

async function loadRelaySessionStateMap(): Promise<RelaySessionStateMap> {
	const stored = await chrome.storage.session.get(RELAY_SESSION_STATE_KEY);
	const rawMap = asRecord(stored[RELAY_SESSION_STATE_KEY]) ?? {};
	const next: RelaySessionStateMap = {};
	for (const [sessionId, rawState] of Object.entries(rawMap)) {
		if (!sessionId.trim()) continue;
		const record = asRecord(rawState);
		next[sessionId] = {
			sessionId,
			selectedTabIds: sanitizeTabIds(record?.selectedTabIds),
			orchestratorPlan: (record?.orchestratorPlan as OrchestratorPlan | null | undefined) ?? null,
			updatedAt: typeof record?.updatedAt === "number" ? record.updatedAt : Date.now(),
		};
	}
	return next;
}

async function saveRelaySessionStateMap(stateMap: RelaySessionStateMap): Promise<void> {
	await chrome.storage.session.set({ [RELAY_SESSION_STATE_KEY]: stateMap });
}

export async function getRelaySessionState(sessionId: string): Promise<RelaySessionState> {
	const stateMap = await loadRelaySessionStateMap();
	return stateMap[sessionId] ?? defaultRelaySessionState(sessionId);
}

async function updateRelaySessionState(
	sessionId: string,
	updater: (current: RelaySessionState) => RelaySessionState,
): Promise<RelaySessionState> {
	const stateMap = await loadRelaySessionStateMap();
	const current = stateMap[sessionId] ?? defaultRelaySessionState(sessionId);
	const next = updater(current);
	stateMap[sessionId] = { ...next, sessionId, updatedAt: Date.now() };
	await saveRelaySessionStateMap(stateMap);
	return stateMap[sessionId];
}

function buildPlanSnapshot(state: RelaySessionState): RelayPlanSnapshot {
	const plan = state.orchestratorPlan;
	const readyTaskIds = plan ? getReadyOrchestratorTaskIds(plan) : [];
	const validationIssues = plan ? getOrchestratorPlanValidationIssues(plan) : [];
	const runningTaskIds = plan?.tasks.filter((task) => task.status === "running").map((task) => task.id) ?? [];
	const maxSlots = Math.max(1, state.selectedTabIds.length || plan?.maxConcurrentTabs || 1);
	const dispatchableTaskIds = plan ? getDispatchableOrchestratorTaskIds(plan, { runningTaskIds, maxSlots }) : [];
	return {
		sessionId: state.sessionId,
		selectedTabIds: state.selectedTabIds,
		plan,
		readyTaskIds,
		dispatchableTaskIds,
		validationIssues,
	};
}

export async function setRelaySessionTabs(sessionId: string, selectedTabIds: unknown): Promise<RelaySessionState> {
	return await updateRelaySessionState(sessionId, (current) => ({
		...current,
		selectedTabIds: sanitizeTabIds(selectedTabIds),
	}));
}

export async function setRelayOrchestratorPlan(sessionId: string, planInput: unknown): Promise<RelayPlanSnapshot> {
	const nextState = await updateRelaySessionState(sessionId, (current) => ({
		...current,
		orchestratorPlan: buildOrchestratorPlan(asRecord(planInput) ?? {}, {
			existingPlan: current.orchestratorPlan,
		}),
	}));
	return buildPlanSnapshot(nextState);
}

export async function getRelayOrchestratorPlan(sessionId: string): Promise<RelayPlanSnapshot> {
	return buildPlanSnapshot(await getRelaySessionState(sessionId));
}

export async function updateRelayOrchestratorTask(sessionId: string, input: unknown): Promise<RelayPlanSnapshot> {
	const record = asRecord(input);
	if (!record) throw new Error("orchestrator.task.update requires an object payload");
	const taskId = typeof record?.taskId === "string" ? record.taskId.trim() : "";
	if (!taskId) throw new Error("orchestrator.task.update requires taskId");

	const nextState = await updateRelaySessionState(sessionId, (current) => {
		const plan = current.orchestratorPlan;
		if (!plan) throw new Error("No orchestrator plan exists for this session.");
		const task = plan.tasks.find((entry) => entry.id === taskId);
		if (!task) throw new Error(`Unknown orchestrator task: ${taskId}`);
		applyTaskUpdates(task, record);
		plan.updatedAt = Date.now();
		return { ...current, orchestratorPlan: { ...plan, tasks: [...plan.tasks] } };
	});
	return buildPlanSnapshot(nextState);
}

function applyTaskUpdates(task: OrchestratorTaskNode, input: Record<string, unknown>): void {
	if (typeof input.status === "string") {
		task.status = normalizeOrchestratorTaskStatus(input.status);
	}
	if (typeof input.assignedProfile === "string") {
		task.assignedProfile = input.assignedProfile.trim() || undefined;
	}
	if (typeof input.assignedTabId === "number" && Number.isInteger(input.assignedTabId)) {
		task.assignedTabId = input.assignedTabId;
	}
	if (typeof input.notes === "string") {
		task.notes = input.notes.trim() || undefined;
	}
	if (typeof input.summary === "string") {
		task.summary = input.summary.trim() || undefined;
	}
	if (typeof input.prompt === "string") {
		task.prompt = input.prompt.trim() || undefined;
	}
}
