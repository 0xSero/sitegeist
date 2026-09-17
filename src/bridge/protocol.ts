/**
 * Wire protocol of the sitegeist bridge. Shared by the extension (src/bridge) and
 * the CLI (cli/src), which imports this file directly.
 *
 *   harness ── stdio MCP ── `sitegeist mcp` ── unix socket ── native host ── native messaging ── extension
 *
 * Both socket legs carry `[uint32 LE length][UTF-8 JSON]` frames. The native host
 * copies frames between the two and only adds/strips `clientId`.
 */

export const NATIVE_HOST_NAME = "ai.sitegeist.bridge";
export const PROTOCOL_VERSION = 1;

/** Native messaging caps host->extension frames at 1 MiB; leave headroom. */
export const MAX_FRAME_TO_EXTENSION = 900 * 1024;
/** Extension->host frames may be up to 64 MiB; screenshots live here. */
export const MAX_FRAME_FROM_EXTENSION = 60 * 1024 * 1024;

export interface ClientHello {
	type: "hello";
	client: {
		/** Harness name, shown as the tab group label ("omp", "claude", ...). */
		name: string;
		/** Stable per-conversation id so a reconnect re-adopts its tabs. */
		session?: string;
		version?: string;
	};
}

export interface ClientRequest {
	type: "request";
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

export type ClientToHost = ClientHello | ClientRequest;

export interface RpcError {
	code: string;
	message: string;
}

export interface HostWelcome {
	type: "welcome";
	clientId: string;
	hostVersion: string;
	extensionConnected: boolean;
}

export interface HostResponse {
	type: "response";
	id: number;
	result?: unknown;
	error?: RpcError;
}

export interface HostEvent {
	type: "event";
	event: string;
	data: Record<string, unknown>;
}

export interface HostExtensionStatus {
	type: "extension_status";
	connected: boolean;
}

export type HostToClient = HostWelcome | HostResponse | HostEvent | HostExtensionStatus;

// ---- host <-> extension ---------------------------------------------------

export interface ExtHello {
	type: "hello";
	version: string;
	protocol: number;
	methods: string[];
}

export interface ExtResponse {
	type: "response";
	clientId: string;
	id: number;
	result?: unknown;
	error?: RpcError;
}

export interface ExtEvent {
	type: "event";
	/** Omitted for broadcast events. */
	clientId?: string;
	event: string;
	data: Record<string, unknown>;
}

export interface ExtPong {
	type: "pong";
}

export type ExtToHost = ExtHello | ExtResponse | ExtEvent | ExtPong;

export interface HostClientConnected {
	type: "client_connected";
	clientId: string;
	client: ClientHello["client"];
}

export interface HostClientDisconnected {
	type: "client_disconnected";
	clientId: string;
}

export interface HostForwardedRequest {
	type: "request";
	clientId: string;
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

export interface HostPing {
	type: "ping";
}

export type HostToExt = HostClientConnected | HostClientDisconnected | HostForwardedRequest | HostPing;

/** Error codes the extension returns. */
export const ERR = {
	BAD_PARAMS: "bad_params",
	NOT_FOUND: "not_found",
	NO_TAB: "no_tab",
	PERMISSION_DENIED: "permission_denied",
	DISABLED: "bridge_disabled",
	INTERNAL: "internal",
	TIMEOUT: "timeout",
	NO_EXTENSION: "no_extension",
} as const;

/** Methods the extension implements; the CLI maps MCP tools onto these. */
export const BRIDGE_METHODS = [
	"tabs.context",
	"tabs.create",
	"tabs.close",
	"tabs.select",
	"tabs.show",
	"navigate",
	"screenshot",
	"snapshot",
	"text",
	"html",
	"find",
	"click",
	"hover",
	"drag",
	"type",
	"press",
	"scroll",
	"fill",
	"evaluate",
	"wait",
	"console.read",
	"network.read",
	"permission.respond",
	"permission.allow",
	"bridge.reload",
	"bridge.debug",
	"bridge.bench",
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];
