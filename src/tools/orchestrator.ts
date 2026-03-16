import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { registerToolRenderer, renderHeader, type ToolRenderer, type ToolRenderResult } from "@mariozechner/pi-web-ui";
import { type Static, Type } from "@sinclair/typebox";
import { html } from "lit";
import { Boxes, GitBranchPlus, Users, Workflow } from "lucide";

type RelayRpcResponse = { success: boolean; result?: unknown; error?: string };

type SessionTabsDetails = {
	sessionId: string;
	selectedTabIds: number[];
	updatedAt?: number;
};

type SubagentSummary = {
	runId: string;
	subagentId?: string;
	status: string;
	sessionId?: string;
	taskId?: string;
	primaryTabId?: number;
	parentRunId?: string;
	createdAt: number;
	updatedAt: number;
	done?: { status: string; summary?: string; error?: string };
};

type OrchestratorPlanDetails = {
	sessionId: string;
	selectedTabIds: number[];
	plan: null | {
		goal: string;
		tasks: Array<{
			id: string;
			title: string;
			status: string;
			assignedTabId?: number;
			summary?: string;
		}>;
	};
	readyTaskIds: string[];
	dispatchableTaskIds: string[];
	validationIssues: string[];
};

type ToolContext = {
	ensureSessionId: () => Promise<string>;
};

const sessionTabsSchema = Type.Object({
	mode: Type.Optional(
		Type.Union([Type.Literal("ids"), Type.Literal("active"), Type.Literal("current_window")], {
			description: "How to choose the tab set. Defaults to ids when tabIds is provided, else active.",
		}),
	),
	tabIds: Type.Optional(Type.Array(Type.Number(), { description: "Explicit tab ids to use for orchestration." })),
});

const taskBindingSchema = Type.Object({
	key: Type.String(),
	description: Type.Optional(Type.String()),
	required: Type.Optional(Type.Boolean()),
	fromTaskId: Type.Optional(Type.String()),
});

const validationRuleSchema = Type.Object({
	kind: Type.Union([
		Type.Literal("url_includes"),
		Type.Literal("dom_includes"),
		Type.Literal("whiteboard_key"),
		Type.Literal("tool_success"),
		Type.Literal("manual"),
	]),
	value: Type.Optional(Type.String()),
	selector: Type.Optional(Type.String()),
	required: Type.Optional(Type.Boolean()),
});

const orchestratorTaskSchema = Type.Object({
	id: Type.String(),
	title: Type.String(),
	summary: Type.Optional(Type.String()),
	kind: Type.Optional(
		Type.Union([
			Type.Literal("browser"),
			Type.Literal("research"),
			Type.Literal("synthesis"),
			Type.Literal("validation"),
			Type.Literal("handoff"),
		]),
	),
	status: Type.Optional(
		Type.Union([
			Type.Literal("pending"),
			Type.Literal("ready"),
			Type.Literal("running"),
			Type.Literal("blocked"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("cancelled"),
		]),
	),
	dependencies: Type.Optional(Type.Array(Type.String())),
	sitePatterns: Type.Optional(Type.Array(Type.String())),
	requiredSkills: Type.Optional(Type.Array(Type.String())),
	assignedProfile: Type.Optional(Type.String()),
	assignedTabId: Type.Optional(Type.Number()),
	prompt: Type.Optional(Type.String()),
	inputs: Type.Optional(Type.Array(taskBindingSchema)),
	outputs: Type.Optional(Type.Array(taskBindingSchema)),
	validations: Type.Optional(Type.Array(validationRuleSchema)),
	notes: Type.Optional(Type.String()),
	maxAttempts: Type.Optional(Type.Number()),
});

const orchestratorPlanSchema = Type.Object({
	goal: Type.String({ description: "The overall multi-step goal." }),
	assumptions: Type.Optional(Type.Array(Type.String())),
	interviewQuestions: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Optional(Type.String()),
				question: Type.String(),
				answerKey: Type.Optional(Type.String()),
				required: Type.Optional(Type.Boolean()),
			}),
		),
	),
	tasks: Type.Array(orchestratorTaskSchema),
	whiteboardKeys: Type.Optional(Type.Array(Type.String())),
	maxConcurrentTabs: Type.Optional(Type.Number()),
});

const updateTaskSchema = Type.Object({
	taskId: Type.String(),
	status: Type.Optional(
		Type.Union([
			Type.Literal("pending"),
			Type.Literal("ready"),
			Type.Literal("running"),
			Type.Literal("blocked"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("cancelled"),
		]),
	),
	assignedTabId: Type.Optional(Type.Number()),
	assignedProfile: Type.Optional(Type.String()),
	notes: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	prompt: Type.Optional(Type.String()),
});

const dispatchTasksSchema = Type.Object({
	maxTasks: Type.Optional(Type.Number({ description: "Optional cap on how many ready tasks to dispatch now." })),
});

const spawnSubagentSchema = Type.Object({
	prompt: Type.String({ description: "Focused helper-agent prompt." }),
	selectedTabId: Type.Optional(Type.Number({ description: "Optional specific tab id for this helper agent." })),
	taskId: Type.Optional(Type.String({ description: "Optional orchestrator task id this subagent is fulfilling." })),
	parentRunId: Type.Optional(Type.String()),
	subagentId: Type.Optional(Type.String()),
});

const awaitSubagentSchema = Type.Object({
	subagentId: Type.Optional(Type.String()),
	subagentIds: Type.Optional(Type.Array(Type.String())),
	timeoutMs: Type.Optional(Type.Number()),
});
const emptyParamsSchema = Type.Object({});

type SessionTabsParams = Static<typeof sessionTabsSchema>;
type OrchestratorPlanParams = Static<typeof orchestratorPlanSchema>;
type UpdateTaskParams = Static<typeof updateTaskSchema>;
type DispatchTasksParams = Static<typeof dispatchTasksSchema>;
type SpawnSubagentParams = Static<typeof spawnSubagentSchema>;
type AwaitSubagentParams = Static<typeof awaitSubagentSchema>;

async function relayRpc(method: string, params: unknown): Promise<unknown> {
	const response = (await chrome.runtime.sendMessage({
		type: "relay_rpc_request",
		method,
		params,
	})) as RelayRpcResponse;
	if (!response?.success) {
		throw new Error(response?.error || `Relay RPC failed: ${method}`);
	}
	return response.result;
}

function normalizeSubagentIds(params: AwaitSubagentParams): string[] {
	if (Array.isArray(params.subagentIds) && params.subagentIds.length > 0) {
		return params.subagentIds.map((entry) => String(entry || "").trim()).filter(Boolean);
	}
	return params.subagentId ? [params.subagentId.trim()] : [];
}

function createSetSessionTabsTool(context: ToolContext): AgentTool<typeof sessionTabsSchema, SessionTabsDetails> {
	return {
		name: "set_session_tabs",
		label: "Set Session Tabs",
		description: "Define which browser tabs the current orchestration session may use.",
		parameters: sessionTabsSchema,
		execute: async (_toolCallId, args): Promise<AgentToolResult<SessionTabsDetails>> => {
			const sessionId = await context.ensureSessionId();
			let tabIds = Array.isArray(args.tabIds) ? args.tabIds : [];
			const mode = args.mode || (tabIds.length > 0 ? "ids" : "active");
			if (mode === "active") {
				const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
				tabIds = typeof tab?.id === "number" ? [tab.id] : [];
			} else if (mode === "current_window") {
				const tabs = await chrome.tabs.query({ currentWindow: true });
				tabIds = tabs.map((tab) => tab.id).filter((tabId): tabId is number => typeof tabId === "number");
			}
			const result = (await relayRpc("session.setTabs", {
				sessionId,
				selectedTabIds: tabIds,
			})) as SessionTabsDetails;
			return {
				content: [{ type: "text", text: `Session tabs set to: ${result.selectedTabIds.join(", ") || "none"}` }],
				details: result,
			};
		},
	};
}

function createSetOrchestratorPlanTool(
	context: ToolContext,
): AgentTool<typeof orchestratorPlanSchema, OrchestratorPlanDetails> {
	return {
		name: "set_orchestrator_plan",
		label: "Set Orchestrator Plan",
		description: "Create or replace the current session's dependency-aware orchestration plan.",
		parameters: orchestratorPlanSchema,
		execute: async (_toolCallId, args) => {
			const sessionId = await context.ensureSessionId();
			const result = (await relayRpc("orchestrator.plan.set", {
				sessionId,
				plan: args,
			})) as OrchestratorPlanDetails;
			return {
				content: [{ type: "text", text: `Stored orchestrator plan with ${result.plan?.tasks.length || 0} tasks.` }],
				details: result,
			};
		},
	};
}

function createGetOrchestratorPlanTool(
	context: ToolContext,
): AgentTool<typeof emptyParamsSchema, OrchestratorPlanDetails> {
	return {
		name: "get_orchestrator_plan",
		label: "Get Orchestrator Plan",
		description: "Inspect the current orchestration plan, ready tasks, dispatchable tasks, and validation issues.",
		parameters: emptyParamsSchema,
		execute: async () => {
			const sessionId = await context.ensureSessionId();
			const result = (await relayRpc("orchestrator.plan.get", { sessionId })) as OrchestratorPlanDetails;
			return {
				content: [{ type: "text", text: `Fetched orchestrator plan for session ${sessionId}.` }],
				details: result,
			};
		},
	};
}

function createUpdateOrchestratorTaskTool(
	context: ToolContext,
): AgentTool<typeof updateTaskSchema, OrchestratorPlanDetails> {
	return {
		name: "update_orchestrator_task",
		label: "Update Orchestrator Task",
		description: "Update one task inside the current orchestration plan.",
		parameters: updateTaskSchema,
		execute: async (_toolCallId, args) => {
			const sessionId = await context.ensureSessionId();
			const result = (await relayRpc("orchestrator.task.update", {
				sessionId,
				...args,
			})) as OrchestratorPlanDetails;
			return {
				content: [{ type: "text", text: `Updated orchestrator task ${args.taskId}.` }],
				details: result,
			};
		},
	};
}

function createDispatchTasksTool(
	context: ToolContext,
): AgentTool<
	typeof dispatchTasksSchema,
	{ sessionId: string; started: SubagentSummary[]; plan: OrchestratorPlanDetails }
> {
	return {
		name: "dispatch_orchestrator_tasks",
		label: "Dispatch Orchestrator Tasks",
		description: "Launch ready orchestration tasks into helper agents using the session tab pool.",
		parameters: dispatchTasksSchema,
		execute: async (_toolCallId, args) => {
			const sessionId = await context.ensureSessionId();
			const result = (await relayRpc("dispatch_orchestrator_tasks", {
				sessionId,
				maxTasks: args.maxTasks,
			})) as { sessionId: string; started: SubagentSummary[]; plan: OrchestratorPlanDetails };
			return {
				content: [{ type: "text", text: `Dispatched ${result.started.length} task(s).` }],
				details: result,
			};
		},
	};
}

function createSpawnSubagentTool(context: ToolContext): AgentTool<typeof spawnSubagentSchema, SubagentSummary> {
	return {
		name: "spawn_subagent",
		label: "Spawn Subagent",
		description: "Launch a focused helper agent for a specific task or research thread.",
		parameters: spawnSubagentSchema,
		execute: async (_toolCallId, args) => {
			const sessionId = await context.ensureSessionId();
			const result = (await relayRpc("spawn_subagent", {
				sessionId,
				...args,
			})) as SubagentSummary;
			return {
				content: [{ type: "text", text: `Spawned subagent ${result.subagentId || result.runId}.` }],
				details: result,
			};
		},
	};
}

function createListSubagentsTool(
	context: ToolContext,
): AgentTool<typeof emptyParamsSchema, { subagents: SubagentSummary[] }> {
	return {
		name: "list_subagents",
		label: "List Subagents",
		description: "List helper agents for the current session.",
		parameters: emptyParamsSchema,
		execute: async () => {
			const sessionId = await context.ensureSessionId();
			const result = (await relayRpc("list_subagents", { sessionId })) as SubagentSummary[];
			return {
				content: [{ type: "text", text: `Found ${result.length} subagent(s).` }],
				details: { subagents: result },
			};
		},
	};
}

function createAwaitSubagentTool(
	context: ToolContext,
): AgentTool<typeof awaitSubagentSchema, { subagents: SubagentSummary[] }> {
	return {
		name: "await_subagent",
		label: "Await Subagent",
		description: "Wait for one or more helper agents to finish.",
		parameters: awaitSubagentSchema,
		execute: async (_toolCallId, args) => {
			const sessionId = await context.ensureSessionId();
			const subagentIds = normalizeSubagentIds(args);
			if (subagentIds.length === 0) {
				throw new Error("await_subagent requires subagentId or subagentIds");
			}
			const result = (await relayRpc("await_subagent", {
				sessionId,
				subagentIds,
				timeoutMs: args.timeoutMs,
			})) as SubagentSummary[];
			return {
				content: [{ type: "text", text: `Awaited ${result.length} subagent(s).` }],
				details: { subagents: result },
			};
		},
	};
}

export function createOrchestratorTools(context: ToolContext): AgentTool<any, any>[] {
	return [
		createSetSessionTabsTool(context),
		createSetOrchestratorPlanTool(context),
		createGetOrchestratorPlanTool(context),
		createUpdateOrchestratorTaskTool(context),
		createDispatchTasksTool(context),
		createSpawnSubagentTool(context),
		createListSubagentsTool(context),
		createAwaitSubagentTool(context),
	];
}

function renderTaskRow(task: NonNullable<OrchestratorPlanDetails["plan"]>["tasks"][number]) {
	return html`<div class="flex items-center gap-2 text-xs">
		<span class="font-medium">${task.id}</span>
		<span class="text-muted-foreground">${task.title}</span>
		<span class="ml-auto uppercase text-[10px] tracking-wide">${task.status}</span>
		${
			typeof task.assignedTabId === "number"
				? html`<span class="text-[10px] text-muted-foreground">tab ${task.assignedTabId}</span>`
				: ""
		}
	</div>`;
}

const sessionTabsRenderer: ToolRenderer<SessionTabsParams, SessionTabsDetails> = {
	render(_params, result): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		const tabs = result?.details?.selectedTabIds || [];
		return {
			content: html`${renderHeader(state, Boxes, `Session Tabs (${tabs.length})`)}`,
			isCustom: false,
		};
	},
};

const orchestratorPlanRenderer: ToolRenderer<any, OrchestratorPlanDetails> = {
	render(_params, result): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		const details = result?.details;
		const tasks = details?.plan?.tasks || [];
		const label = details?.plan ? `Plan: ${details.plan.goal}` : "Orchestrator Plan";
		return {
			content: html`
					${renderHeader(state, Workflow, label)}
					${
						details
							? html`<div class="text-xs text-muted-foreground mt-1">
								<div>Tabs: ${details.selectedTabIds.join(", ") || "none"}</div>
								<div>Ready: ${details.readyTaskIds.join(", ") || "none"}</div>
								<div>Dispatchable: ${details.dispatchableTaskIds.join(", ") || "none"}</div>
								${
									details.validationIssues.length
										? html`<div>Issues: ${details.validationIssues.join(" | ")}</div>`
										: ""
								}
								<div class="mt-2 flex flex-col gap-1">${tasks.slice(0, 8).map((task) => renderTaskRow(task))}</div>
							</div>`
							: ""
					}
			`,
			isCustom: false,
		};
	},
};

function renderSubagentPill(subagent: SubagentSummary) {
	return html`<div class="flex items-center gap-2 text-xs">
		<span class="font-medium">${subagent.subagentId || subagent.runId}</span>
		${subagent.taskId ? html`<span class="text-muted-foreground">task ${subagent.taskId}</span>` : ""}
		${
			typeof subagent.primaryTabId === "number"
				? html`<span class="text-muted-foreground">tab ${subagent.primaryTabId}</span>`
				: ""
		}
		<span class="ml-auto uppercase text-[10px] tracking-wide">${subagent.done?.status || subagent.status}</span>
	</div>`;
}

const subagentRenderer: ToolRenderer<any, SubagentSummary | { subagents: SubagentSummary[] }> = {
	render(_params, result): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		const details = result?.details;
		const subagents = Array.isArray((details as { subagents?: SubagentSummary[] } | undefined)?.subagents)
			? (details as { subagents: SubagentSummary[] }).subagents
			: details
				? [details as SubagentSummary]
				: [];
		return {
			content: html`
					${renderHeader(state, Users, `Subagents (${subagents.length})`)}
					<div class="mt-1 flex flex-col gap-1">${subagents.slice(0, 12).map((subagent) => renderSubagentPill(subagent))}</div>
				`,
			isCustom: false,
		};
	},
};

const dispatchRenderer: ToolRenderer<
	DispatchTasksParams,
	{ sessionId: string; started: SubagentSummary[]; plan: OrchestratorPlanDetails }
> = {
	render(_params, result): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		const started = result?.details?.started || [];
		return {
			content: html`
					${renderHeader(state, GitBranchPlus, `Dispatch (${started.length})`)}
					<div class="mt-1 flex flex-col gap-1">${started.map((subagent) => renderSubagentPill(subagent))}</div>
				`,
			isCustom: false,
		};
	},
};

export function registerOrchestratorToolRenderers() {
	registerToolRenderer("set_session_tabs", sessionTabsRenderer);
	registerToolRenderer("set_orchestrator_plan", orchestratorPlanRenderer);
	registerToolRenderer("get_orchestrator_plan", orchestratorPlanRenderer);
	registerToolRenderer("update_orchestrator_task", orchestratorPlanRenderer);
	registerToolRenderer("dispatch_orchestrator_tasks", dispatchRenderer);
	registerToolRenderer("spawn_subagent", subagentRenderer);
	registerToolRenderer("list_subagents", subagentRenderer);
	registerToolRenderer("await_subagent", subagentRenderer);
}

registerOrchestratorToolRenderers();
