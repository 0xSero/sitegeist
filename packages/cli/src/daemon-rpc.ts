import { type AgentConnection, asRecord, type RunRecord } from "./daemon-shared.js";

type DaemonRpcContext = {
	agents: Map<string, AgentConnection>;
	runs: Map<string, RunRecord>;
	getDefaultAgentId: () => string | null;
	setDefaultAgentId: (agentId: string | null) => void;
	getDefaultAgentOrThrow: (agentId?: string | null) => AgentConnection;
	callAgentRpc: (agent: AgentConnection, method: string, params: unknown) => Promise<unknown>;
};

export async function handleDaemonRpc(context: DaemonRpcContext, method: string, params: unknown) {
	if (method === "relay.ping") {
		return {
			ok: true,
			now: new Date().toISOString(),
			agents: context.agents.size,
			defaultAgentId: context.getDefaultAgentId(),
		};
	}

	if (method === "agents.list") {
		return Array.from(context.agents.values()).map((agent) => ({
			agentId: agent.agentId,
			name: agent.hello.name || "",
			version: agent.hello.version || "",
			browser: agent.hello.browser || "",
			userAgent: agent.hello.userAgent || "",
			connectedAt: agent.connectedAt,
			lastSeenAt: agent.lastSeenAt,
			capabilities: agent.hello.capabilities || {},
		}));
	}

	if (method === "agents.default.get") {
		return { agentId: context.getDefaultAgentId() };
	}

	const paramsRecord = asRecord(params);

	if (method === "agents.default.set") {
		const requestedAgentId = paramsRecord?.agentId;
		if (typeof requestedAgentId !== "string" || !requestedAgentId) {
			throw new Error("agentId must be a non-empty string");
		}
		if (!context.agents.has(requestedAgentId)) {
			throw new Error(`Agent not connected: ${requestedAgentId}`);
		}
		context.setDefaultAgentId(requestedAgentId);
		return { agentId: requestedAgentId };
	}

	if (method === "run.wait") {
		const runId = paramsRecord?.runId;
		const timeoutMs = Number(paramsRecord?.timeoutMs || 600_000);
		if (typeof runId !== "string" || !runId) throw new Error("runId must be provided");
		const run = context.runs.get(runId);
		if (!run) throw new Error(`Unknown runId: ${runId}`);
		if (run.done) return { runId: run.runId, done: run.done };

		return await new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => reject(new Error("Timed out waiting for run")), timeoutMs);
			run.waiters.push((value) => {
				clearTimeout(timeoutId);
				resolve({ runId: value.runId, done: value.done });
			});
		});
	}

	if (method === "run.events") {
		const runId = paramsRecord?.runId;
		if (typeof runId !== "string" || !runId) throw new Error("runId must be provided");
		const run = context.runs.get(runId);
		if (!run) throw new Error(`Unknown runId: ${runId}`);
		return { runId, done: run.done, events: run.events };
	}

	const requestedAgentId = typeof paramsRecord?.agentId === "string" ? paramsRecord.agentId : null;
	const forwardedParams = (() => {
		if (!paramsRecord) return params;
		const { agentId: _ignored, ...rest } = paramsRecord;
		return rest;
	})();
	const agent = context.getDefaultAgentOrThrow(requestedAgentId);
	return await context.callAgentRpc(agent, method, forwardedParams);
}
