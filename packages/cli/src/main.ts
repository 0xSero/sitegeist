import { DEFAULT_PORT, generateToken, isDaemonRunning, readAuth, writeAuth } from "./auth.js";
import { cmdInit } from "./commands/init.js";
import { cmdRun } from "./commands/run.js";
import { cmdStatus } from "./commands/status.js";
import { cmdStop } from "./commands/stop.js";
import { cmdTool, cmdTools } from "./commands/tools.js";
import { startDaemon } from "./daemon-args.js";
import { cmdElectron } from "./electron.js";
import { isNativeMessagingMode, parseArgs } from "./main-helpers.js";
import { handleNativeMessaging } from "./native-host.js";
import {
	cmdRelayAgents,
	cmdRelayDefaultAgent,
	cmdRelayDoctor,
	cmdRelayRpc,
	cmdRelayRun,
	cmdRelayTool,
	cmdRelayTools,
} from "./relay-commands.js";
import { fetchRpc } from "./rpc-client.js";

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
	// Native messaging mode — Chrome launches us with a pipe
	if (isNativeMessagingMode()) {
		await handleNativeMessaging();
		return;
	}

	const { positional, flags } = parseArgs(process.argv.slice(2));
	const cmd = positional[0] || "";

	if (!cmd || cmd === "help" || cmd === "--help") {
		console.log(`sitegeist — zero-config browser control

Commands:
  sitegeist init                       Generate token, install native host, start daemon
  sitegeist run <prompt>               Start agent run, wait for result (--sessionId=... to reuse state)
  sitegeist tool <name> [--args='{}']  Call a browser tool
  sitegeist tools                      List available tools
  sitegeist status                     Show daemon + extension connection status
  sitegeist stop                       Stop the daemon
  sitegeist daemon                     Run daemon in foreground (for debugging)
  sitegeist relay ...                  Relay service commands (rpc, doctor, agents, tools, run)
  sitegeist electron ...               Direct Electron control via agent-browser`);
		return;
	}

	if (cmd === "init")
		return cmdInit(flags, {
			defaultPort: DEFAULT_PORT,
			generateToken,
			readAuth,
			writeAuth,
			isDaemonRunning,
		});
	if (cmd === "daemon") return startDaemon({ foreground: true });
	if (cmd === "status") return cmdStatus();
	if (cmd === "stop") return cmdStop();
	if (cmd === "tools") return cmdTools(flags);
	if (cmd === "tool") return cmdTool(positional, flags);
	if (cmd === "run") return cmdRun(positional, flags);
	if (cmd === "electron") return cmdElectron(process.argv.slice(3));

	// Relay subcommands (merged from relay-service)
	if (cmd === "relay") {
		const sub = positional[1] || "";
		if (!sub || sub === "help" || sub === "--help") {
			console.log(`sitegeist relay — relay service commands

Commands:
  sitegeist relay rpc <method> [--params='{...}']     Call RPC method directly
  sitegeist relay doctor [--agentId=...] [--skipTool] Run connectivity diagnostics
  sitegeist relay agents                              List connected agents
  sitegeist relay default-agent get|set <agentId>     Get or set default agent
  sitegeist relay tools [--agentId=...]               List available tools
  sitegeist relay tool <name> [--args='{...}']        Call a browser tool
  sitegeist relay run <prompt> [--tabs=...] [--sessionId=...]  Start agent run and wait for result`);
			return;
		}
		if (sub === "rpc") return cmdRelayRpc(positional, flags);
		if (sub === "doctor") return cmdRelayDoctor(flags);
		if (sub === "agents") return cmdRelayAgents();
		if (sub === "default-agent") return cmdRelayDefaultAgent(positional);
		if (sub === "tools") return cmdRelayTools(flags);
		if (sub === "tool") return cmdRelayTool(positional, flags);
		if (sub === "run") return cmdRelayRun(positional, flags);
		console.error(`Unknown relay subcommand: ${sub}. Run 'sitegeist relay help' for usage.`);
		process.exit(1);
	}

	// Pass-through RPC for advanced usage
	if (cmd === "rpc") {
		const method = positional[1];
		if (!method) {
			console.error("Usage: sitegeist rpc <method> [--params='{...}']");
			process.exit(1);
		}
		let params: unknown;
		if (flags.params) {
			try {
				params = JSON.parse(flags.params);
			} catch {
				console.error("Invalid JSON for --params");
				process.exit(1);
			}
		}
		const result = await fetchRpc({ method, params });
		print(result);
		return;
	}

	console.error(`Unknown command: ${cmd}. Run 'sitegeist help' for usage.`);
	process.exit(1);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
