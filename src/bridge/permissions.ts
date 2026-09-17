/**
 * Host permissions for bridge sessions.
 *
 * Mode "ask" (default): a harness may only navigate to hosts the user allowed.
 * Unknown hosts raise a permission request that the harness shows (MCP
 * elicitation) or that the user answers in Settings > Bridge. Mode "allow_all"
 * skips the check for people who trust their harness.
 */

const ENABLED_KEY = "bridge_enabled";
const MODE_KEY = "bridge_permission_mode";
const HOSTS_KEY = "bridge_allowed_hosts";
const PENDING_KEY = "bridge_pending_requests";

export type PermissionMode = "ask" | "allow_all";
export type PermissionDecision = "allow_once" | "allow_host" | "deny";

export interface PendingRequest {
	requestId: string;
	clientId: string;
	clientName: string;
	host: string;
	url: string;
	createdAt: number;
}

export async function isBridgeEnabled(): Promise<boolean> {
	const data = await chrome.storage.local.get(ENABLED_KEY);
	return data[ENABLED_KEY] !== false;
}

export async function setBridgeEnabled(enabled: boolean): Promise<void> {
	await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
}

export async function getPermissionMode(): Promise<PermissionMode> {
	const data = await chrome.storage.local.get(MODE_KEY);
	return data[MODE_KEY] === "allow_all" ? "allow_all" : "ask";
}

export async function setPermissionMode(mode: PermissionMode): Promise<void> {
	await chrome.storage.local.set({ [MODE_KEY]: mode });
}

export async function getAllowedHosts(): Promise<string[]> {
	const data = await chrome.storage.local.get(HOSTS_KEY);
	return (data[HOSTS_KEY] as string[] | undefined) ?? [];
}

export async function allowHost(host: string): Promise<void> {
	const hosts = await getAllowedHosts();
	const normalized = host.toLowerCase();
	if (!hosts.includes(normalized)) await chrome.storage.local.set({ [HOSTS_KEY]: [...hosts, normalized] });
}

export async function revokeHost(host: string): Promise<void> {
	const hosts = await getAllowedHosts();
	await chrome.storage.local.set({ [HOSTS_KEY]: hosts.filter((h) => h !== host.toLowerCase()) });
}

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** "docs.example.com" is covered by an entry for "example.com". */
export function hostAllowed(host: string, allowed: string[]): boolean {
	return allowed.some((a) => host === a || host.endsWith(`.${a}`));
}

export async function isUrlAllowed(url: string): Promise<boolean> {
	if ((await getPermissionMode()) === "allow_all") return true;
	const host = hostOf(url);
	if (!host) return url === "about:blank";
	return hostAllowed(host, await getAllowedHosts());
}

// ---- pending requests (visible to the sidepanel settings tab) -----------------

export async function getPendingRequests(): Promise<PendingRequest[]> {
	const data = await chrome.storage.session.get(PENDING_KEY);
	return (data[PENDING_KEY] as PendingRequest[] | undefined) ?? [];
}

export async function addPendingRequest(request: PendingRequest): Promise<void> {
	const pending = await getPendingRequests();
	await chrome.storage.session.set({ [PENDING_KEY]: [...pending, request] });
}

export async function removePendingRequest(requestId: string): Promise<void> {
	const pending = await getPendingRequests();
	await chrome.storage.session.set({ [PENDING_KEY]: pending.filter((p) => p.requestId !== requestId) });
}

/**
 * The sidepanel answers a request by writing the decision here; the service
 * worker picks it up through storage.onChanged.
 */
export const DECISION_KEY_PREFIX = "bridge_decision_";

export async function recordDecision(requestId: string, decision: PermissionDecision): Promise<void> {
	await chrome.storage.session.set({ [`${DECISION_KEY_PREFIX}${requestId}`]: decision });
	await removePendingRequest(requestId);
}
