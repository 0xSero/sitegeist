import { spawn } from "node:child_process";
import { resolveAgentBrowserCommandPrefix } from "../../electron-agent/src/helpers/agent-browser.js";
import { launchElectronApp } from "../../electron-agent/src/helpers/launch.js";

const DEFAULT_ELECTRON_PORT = 9222;
const DEFAULT_ELECTRON_WAIT_MS = 3000;

const parseArgs = (argv: string[]) => {
	const positional: string[] = [];
	const flags: Record<string, string> = {};
	for (const arg of argv) {
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const [key, value] = arg.slice(2).split("=");
		flags[key] = value ?? "true";
	}
	return { positional, flags };
};

const parseNum = (value: string | undefined, fallback: number) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.floor(parsed);
};

const parseExtraArgs = (raw: string | undefined) =>
	String(raw || "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const runPassthrough = async (commandArgs: string[]) => {
	const commandPrefix = resolveAgentBrowserCommandPrefix(process.env.SITEGEIST_ELECTRON_AGENT_BROWSER_COMMAND);
	const [command, ...prefixArgs] = commandPrefix;

	return await new Promise<number>((resolve, reject) => {
		const child = spawn(command, [...prefixArgs, ...commandArgs], {
			stdio: "inherit",
			env: process.env,
		});

		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
};

const runLaunch = async (argv: string[]) => {
	const { positional, flags } = parseArgs(argv);
	const app = positional[0];
	if (!app) {
		throw new Error("Usage: sitegeist electron launch <app> [--port=9222] [--waitMs=3000] [--extraArgs=--foo,--bar]");
	}

	const launch = await launchElectronApp({
		app,
		port: parseNum(flags.port, DEFAULT_ELECTRON_PORT),
		waitMs: parseNum(flags.waitMs, DEFAULT_ELECTRON_WAIT_MS),
		extraArgs: [...parseExtraArgs(flags.extraArgs), ...positional.slice(1)],
	});

	print({ ok: true, launch });
};

const printHelp = () => {
	console.log(`sitegeist electron — direct Electron control via agent-browser

Usage:
  sitegeist electron launch <app> [--port=9222] [--waitMs=3000] [--extraArgs=--foo,--bar]
  sitegeist electron connect <port|cdpUrl>
  sitegeist electron snapshot -i
  sitegeist electron click @e1
  sitegeist electron run <any agent-browser command>

Notes:
  - Commands are passed directly to agent-browser.
  - Set SITEGEIST_ELECTRON_AGENT_BROWSER_COMMAND to override the executable.
  - launch supports macOS (open -a) and Linux executable mode.
`);
};

export async function cmdElectron(rawArgs: string[]) {
	if (rawArgs.length === 0 || rawArgs[0] === "help" || rawArgs[0] === "--help") {
		printHelp();
		return;
	}

	const [subcommand, ...rest] = rawArgs;
	if (subcommand === "launch") {
		await runLaunch(rest);
		return;
	}

	const passthroughArgs = subcommand === "run" ? rest : rawArgs;
	if (passthroughArgs.length === 0) {
		throw new Error("Usage: sitegeist electron <agent-browser-command...>");
	}

	const exitCode = await runPassthrough(passthroughArgs);
	if (exitCode !== 0) {
		throw new Error(`agent-browser command failed with exit code ${exitCode}`);
	}
}
