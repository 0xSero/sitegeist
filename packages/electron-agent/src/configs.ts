import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgentBrowserCommandPrefix } from "./helpers/agent-browser.js";
import type { ElectronAgentConfig } from "./types.js";

const DEFAULT_RELAY_HOST = "127.0.0.1";
const DEFAULT_RELAY_PORT = "17373";
const DEFAULT_BROWSER_TIMEOUT_MS = 120_000;
const RELAY_SECURE_STATE_PATH = path.join(os.homedir(), ".sitegeist", "relay-secure.json");

const parseFlags = (argv: string[]) => {
	const flags: Record<string, string> = {};
	for (const arg of argv) {
		if (!arg.startsWith("--")) continue;
		const [key, value] = arg.slice(2).split("=");
		flags[key] = value ?? "true";
	}
	return flags;
};

const parseIntSafe = (value: string | undefined, fallback: number) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.floor(parsed);
};

const normalizeRelayUrl = (raw: string) => {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
	return `http://${trimmed}`;
};

const buildDefaultAgentId = () => {
	const host =
		os
			.hostname()
			.replace(/[^a-zA-Z0-9_-]/g, "-")
			.slice(0, 32) || "host";
	return `electron-${host}-${process.pid}`;
};

type RelaySecureState = {
	token?: string;
	host?: string;
	port?: number;
};

const readRelaySecureState = (): RelaySecureState => {
	try {
		const raw = fs.readFileSync(RELAY_SECURE_STATE_PATH, "utf8");
		const parsed = JSON.parse(raw) as RelaySecureState;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed;
	} catch {
		return {};
	}
};

export const loadElectronAgentConfig = (argv = process.argv.slice(2)): ElectronAgentConfig => {
	const flags = parseFlags(argv);
	const relaySecureState = readRelaySecureState();
	const relayToken = (flags.token || process.env.SITEGEIST_RELAY_TOKEN || relaySecureState.token || "").trim();
	if (!relayToken) {
		throw new Error(
			"Missing relay token. Set SITEGEIST_RELAY_TOKEN, pass --token=<value>, or run `npm run relay:secure -- start` first.",
		);
	}

	const secureRelayUrl =
		relaySecureState.host && Number.isFinite(relaySecureState.port)
			? `${relaySecureState.host}:${relaySecureState.port}`
			: "";

	const relayUrl = normalizeRelayUrl(
		flags.relayUrl ||
			process.env.SITEGEIST_RELAY_URL ||
			secureRelayUrl ||
			`${DEFAULT_RELAY_HOST}:${DEFAULT_RELAY_PORT}`,
	);
	if (!relayUrl) {
		throw new Error("Missing relay URL. Set SITEGEIST_RELAY_URL or pass --relayUrl=<url>.");
	}

	return {
		relayUrl,
		relayToken,
		agentId: (flags.agentId || process.env.SITEGEIST_ELECTRON_AGENT_ID || buildDefaultAgentId()).trim(),
		agentName: (flags.agentName || process.env.SITEGEIST_ELECTRON_AGENT_NAME || "sitegeist-electron-agent").trim(),
		agentVersion: (flags.agentVersion || process.env.SITEGEIST_ELECTRON_AGENT_VERSION || "0.1.0").trim(),
		reconnectDelayBaseMs: parseIntSafe(
			flags.reconnectBaseMs || process.env.SITEGEIST_ELECTRON_RECONNECT_BASE_MS,
			400,
		),
		reconnectDelayMaxMs: parseIntSafe(
			flags.reconnectMaxMs || process.env.SITEGEIST_ELECTRON_RECONNECT_MAX_MS,
			15_000,
		),
		agentBrowser: {
			commandPrefix: resolveAgentBrowserCommandPrefix(
				flags.browserCommand || process.env.SITEGEIST_ELECTRON_AGENT_BROWSER_COMMAND,
			),
			defaultTimeoutMs: parseIntSafe(
				flags.browserTimeoutMs || process.env.SITEGEIST_ELECTRON_AGENT_BROWSER_TIMEOUT_MS,
				DEFAULT_BROWSER_TIMEOUT_MS,
			),
		},
	};
};
