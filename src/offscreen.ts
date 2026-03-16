import { RelayRunManager } from "./runtime/relay-run-manager.js";

type RelayOffscreenMessage =
	| {
			type: "relay_offscreen_run";
			runId: string;
			prompt: string;
			selectedTabIds: number[];
			sessionId?: string;
	  }
	| {
			type: "relay_offscreen_abort";
			runId: string;
	  }
	| {
			type: "relay_offscreen_spawn_subagent";
			subagentId?: string;
			parentRunId?: string;
			sessionId?: string;
			taskId?: string;
			prompt: string;
			selectedTabId?: number;
	  }
	| {
			type: "relay_offscreen_list_subagents";
			sessionId?: string;
	  }
	| {
			type: "relay_offscreen_await_subagent";
			subagentIds: string[];
			timeoutMs?: number;
	  }
	| {
			type: "relay_offscreen_dispatch_tasks";
			sessionId: string;
			maxTasks?: number;
	  };

const manager = new RelayRunManager(async ({ runId, event, status, final, error, sessionId }) => {
	if (event !== undefined) {
		await chrome.runtime.sendMessage({
			type: "relay_run_event",
			runId,
			event,
			sessionId,
		});
		return;
	}
	await chrome.runtime.sendMessage({
		type: "relay_run_done",
		runId,
		status,
		final,
		error,
		sessionId,
	});
});

chrome.runtime.onMessage.addListener((message: RelayOffscreenMessage, _sender, sendResponse) => {
	void handleMessage(message)
		.then((result) => sendResponse({ success: true, ...result }))
		.catch((error) =>
			sendResponse({
				success: false,
				error: error instanceof Error ? error.message : String(error ?? "Offscreen relay failure"),
			}),
		);
	return true;
});

async function handleMessage(message: RelayOffscreenMessage): Promise<Record<string, unknown>> {
	switch (message.type) {
		case "relay_offscreen_run":
			return await manager.startMainRun(message);
		case "relay_offscreen_abort":
			return { stopped: await manager.stopRun(message.runId) };
		case "relay_offscreen_spawn_subagent":
			return { subagent: await manager.spawnSubagent(message) };
		case "relay_offscreen_list_subagents":
			return { subagents: manager.listSubagents(message.sessionId) };
		case "relay_offscreen_await_subagent":
			return {
				subagents: await manager.awaitSubagents(
					message.subagentIds,
					typeof message.timeoutMs === "number" ? message.timeoutMs : 600_000,
				),
			};
		case "relay_offscreen_dispatch_tasks":
			return await manager.dispatchOrchestratorTasks(message.sessionId, message.maxTasks);
		default:
			throw new Error("Unsupported offscreen relay message");
	}
}
