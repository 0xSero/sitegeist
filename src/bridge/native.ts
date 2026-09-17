/**
 * Bridge runtime in the service worker.
 *
 * Connects to the native host with chrome.runtime.connectNative (the browser
 * spawns the host), keeps one BrowserSession per connected harness, routes
 * requests to the handlers, and relays permission prompts. Reconnects on a
 * backoff and on a 30 s alarm, which also keeps the worker alive.
 */

import { setCdpMessageHandler } from "../browser/inject.js";
import { BrowserSession, listSessions } from "../browser/session.js";
import {
	addPendingRequest,
	allowHost,
	DECISION_KEY_PREFIX,
	getPermissionMode,
	hostOf,
	isBridgeEnabled,
	isUrlAllowed,
	type PermissionDecision,
	removePendingRequest,
} from "./permissions.js";
import {
	BRIDGE_METHODS,
	ERR,
	type ExtToHost,
	type HostClientConnected,
	type HostForwardedRequest,
	type HostToExt,
	NATIVE_HOST_NAME,
	PROTOCOL_VERSION,
} from "./protocol.js";
import { BridgeError, type HandlerContext, handlers } from "./tools.js";

const ALARM_NAME = "sitegeist-bridge-keepalive";
const WORKER_STARTED_AT = Date.now();
const LOG_MAX = 200;
/** Ring buffer of timing lines, readable through bridge.debug. */
const log: string[] = [];
function trace(line: string): void {
	log.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
	if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
}
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PERMISSION_TIMEOUT_MS = 120000;

interface ClientState {
	clientId: string;
	name: string;
	sessionKey: string;
	session?: BrowserSession;
	/** Only one request at a time per client; the CLI serialises anyway. */
	queue: Promise<void>;
	inFlight?: { method: string; since: number };
	lastError?: string;
}

/** A handler that never settles must not wedge the client's queue forever. */
const HANDLER_TIMEOUT_MS = 90000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new BridgeError(ERR.TIMEOUT, `${label} did not finish within ${ms} ms`)),
			ms,
		);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

let port: chrome.runtime.Port | undefined;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const clients = new Map<string, ClientState>();
const pendingDecisions = new Map<string, (decision: PermissionDecision) => void>();

function send(message: ExtToHost): void {
	try {
		port?.postMessage(message);
	} catch (err) {
		console.warn("[Bridge] post failed:", err);
	}
}

function sessionIdFor(client: HostClientConnected["client"], clientId: string): string {
	const name = client.name.replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "harness";
	const key = client.session ? client.session.replace(/[^a-z0-9_-]/gi, "").slice(0, 64) : clientId;
	return `bridge-${name}-${key}`;
}

async function getSession(state: ClientState): Promise<BrowserSession> {
	if (!state.session) {
		state.session = await BrowserSession.open(state.sessionKey, state.name);
	}
	return state.session;
}

async function onClientConnected(msg: HostClientConnected): Promise<void> {
	const state: ClientState = {
		clientId: msg.clientId,
		name: msg.client.name || "harness",
		sessionKey: sessionIdFor(msg.client, msg.clientId),
		queue: Promise.resolve(),
	};
	clients.set(msg.clientId, state);
	// Open eagerly so the tab group exists (and re-adopts tabs) before the first call.
	await getSession(state).catch((err) => console.warn("[Bridge] session open failed:", err));
	console.log(`[Bridge] client ${msg.clientId} (${state.name}) connected as ${state.sessionKey}`);
}

async function onClientDisconnected(clientId: string): Promise<void> {
	const state = clients.get(clientId);
	clients.delete(clientId);
	if (state?.session) await state.session.suspend();
	for (const [requestId, resolve] of pendingDecisions) {
		if (requestId.startsWith(`${clientId}:`)) {
			resolve("deny");
			pendingDecisions.delete(requestId);
		}
	}
}

async function askPermission(state: ClientState, url: string): Promise<boolean> {
	if (await isUrlAllowed(url)) return true;
	const host = hostOf(url);
	if (!host) return false;
	const requestId = `${state.clientId}:${crypto.randomUUID()}`;
	const decision = new Promise<PermissionDecision>((resolve) => {
		pendingDecisions.set(requestId, resolve);
		setTimeout(() => {
			if (pendingDecisions.delete(requestId)) resolve("deny");
		}, PERMISSION_TIMEOUT_MS);
	});
	await addPendingRequest({
		requestId,
		clientId: state.clientId,
		clientName: state.name,
		host,
		url,
		createdAt: Date.now(),
	});
	send({
		type: "event",
		clientId: state.clientId,
		event: "permission_request",
		data: { requestId, host, url, timeoutMs: PERMISSION_TIMEOUT_MS },
	});
	const result = await decision;
	await removePendingRequest(requestId);
	if (result === "allow_host") await allowHost(host);
	return result !== "deny";
}

function resolveDecision(requestId: string, decision: PermissionDecision): boolean {
	const resolve = pendingDecisions.get(requestId);
	if (!resolve) return false;
	pendingDecisions.delete(requestId);
	resolve(decision);
	return true;
}

async function runRequest(state: ClientState, req: HostForwardedRequest): Promise<void> {
	const reply = (result?: unknown, error?: BridgeError) =>
		send({
			type: "response",
			clientId: req.clientId,
			id: req.id,
			...(error ? { error: error.toRpc() } : { result }),
		});

	try {
		if (!(await isBridgeEnabled())) {
			throw new BridgeError(ERR.DISABLED, "The sitegeist bridge is disabled in Settings > Bridge.");
		}
		const handler = handlers[req.method];
		if (!handler) throw new BridgeError(ERR.NOT_FOUND, `Unknown method ${req.method}`);
		state.inFlight = { method: req.method, since: Date.now() };
		const t0 = performance.now();
		const session = await withTimeout(getSession(state), 15000, "session open");
		const tSession = Math.round(performance.now() - t0);
		const ctx: HandlerContext = {
			session,
			checkUrl: async (url: string) => {
				if (!(await askPermission(state, url))) {
					const mode = await getPermissionMode();
					throw new BridgeError(
						ERR.PERMISSION_DENIED,
						`Not allowed to open ${hostOf(url) || url}. ` +
							(mode === "ask"
								? "The user can allow it in the sitegeist side panel under Settings > Bridge, or answer the permission prompt."
								: "Bridge navigation is blocked."),
					);
				}
			},
		};
		const result = await withTimeout(handler(ctx, req.params ?? {}), HANDLER_TIMEOUT_MS, req.method);
		trace(`${state.name} ${req.method} session=${tSession}ms total=${Math.round(performance.now() - t0)}ms`);
		reply(result);
	} catch (err) {
		state.lastError = `${req.method}: ${err instanceof Error ? err.message : String(err)}`;
		console.warn("[Bridge]", state.lastError);
		if (err instanceof BridgeError) reply(undefined, err);
		else reply(undefined, new BridgeError(ERR.INTERNAL, err instanceof Error ? err.message : String(err)));
	} finally {
		state.inFlight = undefined;
	}
}

function onHostMessage(message: HostToExt): void {
	switch (message.type) {
		case "ping":
			send({ type: "pong" });
			return;
		case "client_connected":
			void onClientConnected(message);
			return;
		case "client_disconnected":
			void onClientDisconnected(message.clientId);
			return;
		case "request": {
			if (message.method === "permission.respond") {
				// Answers must bypass the per-client queue: the request waiting for them is at its head.
				const p = message.params ?? {};
				const decision = String(p.decision) as PermissionDecision;
				const ok = ["allow_once", "allow_host", "deny"].includes(decision);
				send({
					type: "response",
					clientId: message.clientId,
					id: message.id,
					...(ok
						? { result: { accepted: resolveDecision(String(p.requestId), decision) } }
						: { error: { code: ERR.BAD_PARAMS, message: "decision must be allow_once, allow_host, or deny" } }),
				});
				return;
			}
			if (message.method === "permission.allow") {
				// `sitegeist allow <host>`: a local user process granting a host, same trust as the side panel.
				const host = String(message.params?.host ?? "").toLowerCase();
				if (!host) {
					send({
						type: "response",
						clientId: message.clientId,
						id: message.id,
						error: { code: ERR.BAD_PARAMS, message: "host is required" },
					});
					return;
				}
				allowHost(host).then(() =>
					send({ type: "response", clientId: message.clientId, id: message.id, result: { allowed: host } }),
				);
				return;
			}
			if (message.method === "bridge.debug") {
				Promise.all([listSessions(), chrome.permissions.getAll()]).then(([sessions, perms]) =>
					send({
						type: "response",
						clientId: message.clientId,
						id: message.id,
						result: {
							version: chrome.runtime.getManifest().version,
							userScriptsApi: typeof (chrome as { userScripts?: unknown }).userScripts !== "undefined",
							grantedPermissions: perms.permissions ?? [],
							workerUptimeS: Math.round((Date.now() - WORKER_STARTED_AT) / 1000),
							log: [...log],
							clients: [...clients.values()].map((c) => ({
								clientId: c.clientId,
								name: c.name,
								sessionKey: c.sessionKey,
								hasSession: !!c.session,
								inFlight: c.inFlight,
								lastError: c.lastError,
							})),
							sessions: sessions.map((s) => ({
								id: s.id,
								label: s.label,
								tabs: s.tabIds.length,
								windowId: s.windowId,
							})),
						},
					}),
				);
				return;
			}
			if (message.method === "bridge.bench") {
				// Diagnostics: how long do the Chrome APIs the session model relies on take right now?
				(async () => {
					const timings: Record<string, number> = {};
					const time = async (label: string, fn: () => Promise<unknown>) => {
						const t = performance.now();
						try {
							await fn();
						} catch (err) {
							timings[`${label}_error`] = -1;
							console.warn("[Bridge bench]", label, err);
						}
						timings[label] = Math.round(performance.now() - t);
					};
					await time("storage.session.get", () => chrome.storage.session.get("browser_sessions"));
					await time("storage.local.get", () => chrome.storage.local.get("bridge_enabled"));
					await time("windows.getLastFocused", () => chrome.windows.getLastFocused({ windowTypes: ["normal"] }));
					await time("windows.getAll", () => chrome.windows.getAll());
					await time("tabs.query(all)", async () => {
						timings.tabCount = (await chrome.tabs.query({})).length;
					});
					await time("tabGroups.query(all)", async () => {
						timings.groupCount = (await chrome.tabGroups.query({})).length;
					});
					await time("debugger.getTargets", async () => {
						timings.targetCount = (await chrome.debugger.getTargets()).length;
					});
					await time("session.open", () => BrowserSession.open(`bench-${Date.now()}`, "bench"));
					send({ type: "response", clientId: message.clientId, id: message.id, result: timings });
				})();
				return;
			}
			if (message.method === "bridge.reload") {
				// Development aid: reload the extension so a rebuilt bundle is picked up without the extensions page.
				send({ type: "response", clientId: message.clientId, id: message.id, result: { reloading: true } });
				setTimeout(() => chrome.runtime.reload(), 200);
				return;
			}
			let state = clients.get(message.clientId);
			if (!state) {
				// Host restarted mid-flight or we missed the connect; treat as a fresh client.
				state = {
					clientId: message.clientId,
					name: "harness",
					sessionKey: `bridge-harness-${message.clientId}`,
					queue: Promise.resolve(),
				};
				clients.set(message.clientId, state);
			}
			const current = state;
			current.queue = current.queue.then(() => runRequest(current, message)).catch(() => undefined);
			return;
		}
	}
}

function scheduleReconnect(): void {
	if (reconnectTimer) return;
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = undefined;
		connect();
	}, delay);
}

function connect(): void {
	if (port) return;
	let next: chrome.runtime.Port;
	try {
		next = chrome.runtime.connectNative(NATIVE_HOST_NAME);
	} catch (err) {
		console.debug("[Bridge] connectNative failed:", err);
		scheduleReconnect();
		return;
	}
	port = next;
	next.onMessage.addListener((message: HostToExt) => onHostMessage(message));
	next.onDisconnect.addListener(() => {
		const reason = chrome.runtime.lastError?.message ?? "closed";
		// "Specified native messaging host not found" means the CLI installer has not run yet.
		console.debug("[Bridge] native host disconnected:", reason);
		if (port === next) port = undefined;
		for (const state of clients.values()) void state.session?.suspend();
		clients.clear();
		scheduleReconnect();
	});
	reconnectDelay = RECONNECT_MIN_MS;
	trace("native port connected");
	send({
		type: "hello",
		version: chrome.runtime.getManifest().version,
		protocol: PROTOCOL_VERSION,
		methods: [...BRIDGE_METHODS],
	});
}

/** Wire the bridge into the service worker. Safe to call on every worker start. */
export function startBridge(): void {
	// Injected code has no runtime providers in the worker; echo so callers can probe the shim.
	setCdpMessageHandler(async (message) => ({ echo: message }));
	chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === ALARM_NAME) {
			trace(`alarm (port ${port ? "open" : "closed"})`);
			connect();
		}
	});
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && "bridge_enabled" in changes) connect();
		if (area !== "session") return;
		for (const key of Object.keys(changes)) {
			if (!key.startsWith(DECISION_KEY_PREFIX)) continue;
			const decision = changes[key].newValue as PermissionDecision | undefined;
			if (!decision) continue;
			resolveDecision(key.slice(DECISION_KEY_PREFIX.length), decision);
			chrome.storage.session.remove(key).catch(() => undefined);
		}
	});
	chrome.action.onClicked.addListener(() => connect());
	connect();
}

/** For the sidepanel: which harnesses are connected right now. */
export function connectedClients(): Array<{ clientId: string; name: string; sessionKey: string }> {
	return [...clients.values()].map((c) => ({ clientId: c.clientId, name: c.name, sessionKey: c.sessionKey }));
}
