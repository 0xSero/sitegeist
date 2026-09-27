/**
 * BrowserSession: the set of tabs an agent owns.
 *
 * Every agent (a sidepanel chat session or an external harness connected through
 * the bridge) gets one session. The session owns a Chrome tab group in one window,
 * creates its tabs inactive, tracks which tab tools act on, and never touches tabs
 * outside the group. Nothing here changes window focus or the active tab; that is
 * reserved for the explicit `show()` call.
 *
 * State is mirrored to chrome.storage.local so it survives sidepanel reloads, service
 * worker restarts and extension reloads (Chrome's tab groups do too). Tab and group ids
 * that no longer exist are dropped on reconcile, which is what happens after a browser
 * restart.
 */

import { detachTab, ensureAttached, isRestrictedUrl, releaseAgentViewport } from "./cdp.js";

const STORAGE_KEY = "browser_sessions";
const GROUP_PREFIX = "Sitegeist";
const GROUP_COLORS: `${chrome.tabGroups.Color}`[] = [
	"blue",
	"cyan",
	"green",
	"orange",
	"red",
	"pink",
	"purple",
	"yellow",
];

export interface TabInfo {
	id: number;
	url: string;
	title: string;
	current: boolean;
	favicon?: string;
	/** False when the tab sits outside the session's group (dragged out, or grouping failed). */
	inGroup: boolean;
}

interface PersistedSession {
	id: string;
	label: string;
	color: `${chrome.tabGroups.Color}`;
	windowId: number;
	groupId?: number;
	tabIds: number[];
	currentTabId?: number;
	/** The tab the panel that owns this session was opened on (Claude-style per-tab binding). */
	homeTabId?: number;
	/** Last time a tool touched the session (ms since epoch); drives cleanup of abandoned sessions. */
	lastUsedAt?: number;
}

type SessionTable = Record<string, PersistedSession>;

async function readTable(): Promise<SessionTable> {
	const data = await chrome.storage.local.get(STORAGE_KEY);
	return (data[STORAGE_KEY] as SessionTable | undefined) ?? {};
}

async function writeTable(table: SessionTable): Promise<void> {
	await chrome.storage.local.set({ [STORAGE_KEY]: table });
}

/** Chromium refuses tab edits while a tab is being dragged or animated; retry briefly. */
async function withGroupRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
	let lastError: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			await new Promise((r) => setTimeout(r, 250 * (i + 1)));
		}
	}
	throw lastError;
}

/** Tab ids owned by any session. Used by the foreground guard in the service worker. */
export async function allOwnedTabIds(): Promise<Set<number>> {
	const table = await readTable();
	const ids = new Set<number>();
	for (const s of Object.values(table)) for (const id of s.tabIds) ids.add(id);
	return ids;
}

/** Find the session that owns a tab, if any. */
export async function sessionOwningTab(tabId: number): Promise<PersistedSession | undefined> {
	const table = await readTable();
	return Object.values(table).find((s) => s.tabIds.includes(tabId));
}

/** Summaries of all sessions, for UI. */
export async function listSessions(): Promise<PersistedSession[]> {
	return Object.values(await readTable());
}

/** The id of the session whose home tab is `tabId`, if any. */
export async function sessionIdForTab(tabId: number): Promise<string | undefined> {
	const table = await readTable();
	return Object.values(table).find((s) => s.homeTabId === tabId)?.id;
}

/**
 * Ungroup tabs sitting in "Sitegeist · ..." groups that no live session owns (left behind
 * by an extension reload, which clears session storage but not the browser's groups).
 */
export async function cleanupOrphanGroups(): Promise<number> {
	const table = await readTable();
	const liveGroups = new Set<number>();
	for (const s of Object.values(table)) if (s.groupId !== undefined) liveGroups.add(s.groupId);
	const groups = await chrome.tabGroups.query({}).catch(() => []);
	let released = 0;
	for (const g of groups) {
		if (!g.title?.startsWith(`${GROUP_PREFIX} ·`) || liveGroups.has(g.id)) continue;
		const tabs = await chrome.tabs.query({ groupId: g.id }).catch(() => []);
		for (const t of tabs) {
			if (t.id === undefined) continue;
			await chrome.tabs.ungroup(t.id).catch(() => undefined);
			released++;
		}
	}
	return released;
}

function isBlankUrl(url: string | undefined): boolean {
	return (
		!url ||
		url === "about:blank" ||
		url.startsWith("chrome://newtab") ||
		url.startsWith("brave://newtab") ||
		url.startsWith("edge://newtab") ||
		url.startsWith("chrome://new-tab-page")
	);
}

/**
 * Tidy the session table. Dead tab ids are dropped everywhere. Bridge sessions whose
 * client is gone (`liveIds` lacks them) lose their blank tabs, are forgotten once they
 * own nothing, and have their group collapsed after `idleMs` so finished agent work
 * stops cluttering the tab strip (one click on the group closes it). Side-panel sessions
 * are left alone apart from dead ids: their tabs are the user's.
 */
export async function pruneSessions(
	liveIds: Set<string>,
	idleMs = 30 * 60 * 1000,
): Promise<{
	dropped: number;
	closedTabs: number;
}> {
	const table = await readTable();
	const liveTabs = new Map<number, chrome.tabs.Tab>();
	for (const t of await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[])) {
		if (t.id !== undefined) liveTabs.set(t.id, t);
	}
	let dropped = 0;
	let closedTabs = 0;
	const now = Date.now();
	for (const s of Object.values(table)) {
		const inst = instances.get(s.id);
		const state = inst ? (inst as unknown as { state: PersistedSession }).state : s;
		state.tabIds = state.tabIds.filter((id) => liveTabs.has(id));
		if (state.currentTabId !== undefined && !liveTabs.has(state.currentTabId))
			state.currentTabId = state.tabIds[state.tabIds.length - 1];
		if (state.homeTabId !== undefined && !liveTabs.has(state.homeTabId)) state.homeTabId = undefined;
		const isBridge = state.id.startsWith("bridge-");
		if (isBridge && !liveIds.has(state.id)) {
			for (const id of [...state.tabIds]) {
				const tab = liveTabs.get(id);
				if (!tab || !isBlankUrl(tab.url ?? tab.pendingUrl) || tab.active) continue;
				await chrome.tabs.remove(id).catch(() => undefined);
				state.tabIds = state.tabIds.filter((x) => x !== id);
				closedTabs++;
			}
			if (state.currentTabId !== undefined && !state.tabIds.includes(state.currentTabId))
				state.currentTabId = state.tabIds[state.tabIds.length - 1];
			if (state.tabIds.length === 0) {
				delete table[state.id];
				instances.delete(state.id);
				dropped++;
				continue;
			}
			const userLooking = state.tabIds.some((id) => liveTabs.get(id)?.active);
			if (state.groupId !== undefined && !userLooking && now - (state.lastUsedAt ?? 0) > idleMs) {
				await chrome.tabGroups.update(state.groupId, { collapsed: true }).catch(() => undefined);
			}
		} else if (!isBridge && state.tabIds.length === 0 && state.homeTabId === undefined) {
			delete table[state.id];
			instances.delete(state.id);
			dropped++;
			continue;
		}
		table[state.id] = state;
	}
	await writeTable(table);
	return { dropped, closedTabs };
}

/**
 * Keep a single live side-panel group per window: release every other non-bridge
 * session in the window (ungroup its tabs, which stay open, and forget it).
 */
export async function releaseOtherPanelSessions(windowId: number, keepId: string): Promise<void> {
	const table = await readTable();
	for (const s of Object.values(table)) {
		if (s.id === keepId || s.id.startsWith("bridge-") || s.windowId !== windowId) continue;
		for (const tabId of s.tabIds) {
			await detachTab(tabId, true);
			await chrome.tabs.ungroup(tabId).catch(() => undefined);
		}
		delete table[s.id];
		instances.delete(s.id);
	}
	await writeTable(table);
}

/** "omp", then "omp 2", "omp 3" ...: two agents must not share a group title. */
function uniqueLabel(table: SessionTable, label: string, selfId?: string): string {
	const taken = new Set(
		Object.values(table)
			.filter((s) => s.id !== selfId)
			.map((s) => s.label),
	);
	if (!taken.has(label)) return label;
	for (let n = 2; ; n++) if (!taken.has(`${label} ${n}`)) return `${label} ${n}`;
}

function pickColor(table: SessionTable): `${chrome.tabGroups.Color}` {
	const used = new Set(Object.values(table).map((s) => s.color));
	return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[Object.keys(table).length % GROUP_COLORS.length];
}

async function tabExists(tabId: number): Promise<chrome.tabs.Tab | undefined> {
	try {
		return await chrome.tabs.get(tabId);
	} catch {
		return undefined;
	}
}

export class NoTabError extends Error {
	constructor() {
		super("This session has no tab yet. Call navigate with a URL first (it opens a tab in your group).");
	}
}

/** One live instance per session id in this context, so concurrent clients share state. */
const instances = new Map<string, BrowserSession>();

export class BrowserSession {
	private state: PersistedSession;

	private constructor(state: PersistedSession) {
		this.state = state;
	}

	get id(): string {
		return this.state.id;
	}

	get label(): string {
		return this.state.label;
	}

	get windowId(): number {
		return this.state.windowId;
	}

	get tabIds(): number[] {
		return [...this.state.tabIds];
	}

	get currentTabId(): number | undefined {
		return this.state.currentTabId;
	}

	get homeTabId(): number | undefined {
		return this.state.homeTabId;
	}

	/**
	 * Bind this session to the tab its panel lives on, so reopening the panel there restores
	 * it. Exclusive: any other session that claimed this tab as its home tab gives it up, so a
	 * tab maps to exactly one task (e.g. after "New chat" rebinds the tab to a fresh session).
	 */
	async setHomeTab(tabId: number): Promise<void> {
		const table = await readTable();
		for (const s of Object.values(table)) {
			if (s.id !== this.state.id && s.homeTabId === tabId) {
				s.homeTabId = undefined;
				const other = instances.get(s.id);
				if (other) other.state.homeTabId = undefined;
			}
		}
		this.state.homeTabId = tabId;
		table[this.state.id] = this.state;
		await writeTable(table);
	}

	/**
	 * Open (or re-adopt) a session. `windowId` is where new tabs go; for the sidepanel
	 * that is its own window, for the bridge the last focused normal window.
	 */
	static async open(id: string, label: string, windowId?: number): Promise<BrowserSession> {
		const existing = instances.get(id);
		if (existing) {
			if (windowId !== undefined) existing.state.windowId = windowId;
			await existing.reconcile();
			return existing;
		}
		const table = await readTable();
		let state = table[id];
		if (!state) {
			state = {
				id,
				label: uniqueLabel(table, label),
				color: pickColor(table),
				windowId: windowId ?? (await lastFocusedWindowId()),
				tabIds: [],
			};
		} else {
			if (state.label !== label && !state.label.startsWith(`${label} `)) state.label = uniqueLabel(table, label, id);
			if (windowId !== undefined) state.windowId = windowId;
		}
		const session = new BrowserSession(state);
		instances.set(id, session);
		await session.reconcile();
		return session;
	}

	/** Rename a session in place (a sidepanel session gets its real id on first save). */
	static async rename(oldId: string, newId: string): Promise<void> {
		const table = await readTable();
		const state = table[oldId];
		if (!state) return;
		delete table[oldId];
		state.id = newId;
		table[newId] = state;
		await writeTable(table);
		const inst = instances.get(oldId);
		if (inst) {
			instances.delete(oldId);
			inst.state.id = newId;
			instances.set(newId, inst);
		}
	}

	private async persist(): Promise<void> {
		this.state.lastUsedAt = Date.now();
		const table = await readTable();
		table[this.state.id] = this.state;
		await writeTable(table);
	}

	/** Drop tabs that no longer exist and re-find the group if the id went stale. */
	async reconcile(): Promise<void> {
		const alive: number[] = [];
		for (const id of this.state.tabIds) {
			if (await tabExists(id)) alive.push(id);
		}
		this.state.tabIds = alive;
		if (this.state.currentTabId !== undefined && !alive.includes(this.state.currentTabId)) {
			this.state.currentTabId = alive[alive.length - 1];
		}
		if (this.state.homeTabId !== undefined && !(await tabExists(this.state.homeTabId))) {
			this.state.homeTabId = undefined;
		}
		// A group belongs to exactly one session. (Re-finding a group by title used to hand a
		// fresh session another agent's group whenever their labels matched.)
		const table = await readTable();
		const claimedElsewhere =
			this.state.groupId !== undefined &&
			Object.values(table).some((s) => s.id !== this.state.id && s.groupId === this.state.groupId);
		const group = claimedElsewhere ? undefined : await this.liveGroup();
		if (!group) this.state.groupId = undefined;
		// Chrome puts tabs opened from a grouped tab into that group; those are this agent's.
		if (this.state.groupId !== undefined) {
			const others = new Set<number>();
			for (const s of Object.values(table)) if (s.id !== this.state.id) for (const id of s.tabIds) others.add(id);
			for (const t of await chrome.tabs
				.query({ groupId: this.state.groupId })
				.catch(() => [] as chrome.tabs.Tab[])) {
				if (t.id !== undefined && !alive.includes(t.id) && !others.has(t.id)) alive.push(t.id);
			}
			this.state.tabIds = alive;
		}
		// Tabs that fell out of the group (or never made it in) go back, so the user always sees
		// an agent's tabs together.
		for (const id of alive) {
			const tab = await tabExists(id);
			if (tab && (this.state.groupId === undefined || tab.groupId !== this.state.groupId)) await this.groupTab(id);
		}
		await this.persist();
	}

	private groupTitle(): string {
		return `${GROUP_PREFIX} · ${this.state.label}`;
	}

	/** Change the label; updates the tab group title. */
	async setLabel(label: string): Promise<void> {
		this.state.label = label;
		if (this.state.groupId !== undefined) {
			try {
				await chrome.tabGroups.update(this.state.groupId, { title: this.groupTitle() });
			} catch {
				/* group gone */
			}
		}
		await this.persist();
	}

	/** The session's group if it still exists. */
	private async liveGroup(): Promise<chrome.tabGroups.TabGroup | undefined> {
		if (this.state.groupId === undefined) return undefined;
		try {
			return await chrome.tabGroups.get(this.state.groupId);
		} catch {
			this.state.groupId = undefined;
			return undefined;
		}
	}

	/**
	 * Put a tab into the session group, creating the group in the tab's window. A tab in
	 * another window is moved next to the group first (a group cannot span windows). If the
	 * existing group refuses the tab, a fresh group is made rather than leaving it loose.
	 */
	private async groupTab(tabId: number): Promise<void> {
		try {
			let tab = await chrome.tabs.get(tabId);
			if (tab.pinned) return; // pinned tabs cannot be grouped
			const win = await chrome.windows.get(tab.windowId).catch(() => undefined);
			if (win && win.type !== "normal") return; // popups and app windows have no tab strip
			const group = await this.liveGroup();
			if (group && tab.groupId === group.id) return;
			if (group) {
				try {
					if (group.windowId !== tab.windowId) {
						await withGroupRetry(() => chrome.tabs.move(tabId, { windowId: group.windowId, index: -1 }));
						tab = await chrome.tabs.get(tabId);
					}
					await withGroupRetry(() => chrome.tabs.group({ tabIds: [tabId], groupId: group.id }));
					return;
				} catch (err) {
					console.warn("[BrowserSession] joining group failed, starting a new one:", err);
					this.state.groupId = undefined;
				}
			}
			if (tab.groupId !== undefined && tab.groupId !== -1) await chrome.tabs.ungroup(tabId).catch(() => undefined);
			this.state.groupId = await withGroupRetry(() =>
				chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } }),
			);
			this.state.windowId = tab.windowId;
			await chrome.tabGroups.update(this.state.groupId, { title: this.groupTitle(), color: this.state.color });
		} catch (err) {
			// A closing window or a tab being dragged must not fail the tool; the tab stays owned.
			console.warn("[BrowserSession] group failed:", err);
		}
	}

	/** Window for new tabs: the group's window when it exists, else the session window. */
	private async targetWindowId(): Promise<number> {
		const group = await this.liveGroup();
		if (group) return group.windowId;
		try {
			const win = await chrome.windows.get(this.state.windowId);
			if (win.type === "normal") return this.state.windowId;
		} catch {
			/* window gone */
		}
		this.state.windowId = await lastFocusedWindowId();
		return this.state.windowId;
	}

	/**
	 * Create a new inactive tab in the session's group and make it current. With a url the
	 * tab loads it directly (callers wait for the load); without one it starts blank.
	 */
	async createTab(url?: string): Promise<chrome.tabs.Tab> {
		const windowId = await this.targetWindowId();
		const tab = await chrome.tabs.create({ url: url ?? "about:blank", windowId, active: false });
		if (tab.id === undefined) throw new Error("Failed to create tab");
		await this.adopt(tab.id);
		return tab;
	}

	/** Take ownership of an existing tab (user handed it over, or a popup opened from an owned tab). */
	async adopt(tabId: number, makeCurrent = true): Promise<void> {
		// A tab belongs to one session; take it away from whoever had it before.
		const table = await readTable();
		for (const s of Object.values(table)) {
			if (s.id === this.state.id || !s.tabIds.includes(tabId)) continue;
			const other = instances.get(s.id);
			const target = other ? other.state : s;
			target.tabIds = target.tabIds.filter((id) => id !== tabId);
			if (target.currentTabId === tabId) target.currentTabId = target.tabIds[target.tabIds.length - 1];
			table[s.id] = target;
		}
		await writeTable(table);
		if (!this.state.tabIds.includes(tabId)) this.state.tabIds.push(tabId);
		if (makeCurrent) this.state.currentTabId = tabId;
		await this.groupTab(tabId);
		await this.persist();
	}

	/** Swap a tab id Chrome replaced (prerender/instant pages commit into a new tab). */
	async replaceTabId(oldId: number, newId: number): Promise<void> {
		if (!this.state.tabIds.includes(oldId)) return;
		this.state.tabIds = this.state.tabIds.map((id) => (id === oldId ? newId : id));
		if (this.state.currentTabId === oldId) this.state.currentTabId = newId;
		if (this.state.homeTabId === oldId) this.state.homeTabId = newId;
		await this.groupTab(newId);
		await this.persist();
	}

	/** Release a tab without closing it. */
	async release(tabId: number): Promise<void> {
		this.state.tabIds = this.state.tabIds.filter((id) => id !== tabId);
		if (this.state.currentTabId === tabId) this.state.currentTabId = this.state.tabIds[this.state.tabIds.length - 1];
		await detachTab(tabId, true);
		try {
			await chrome.tabs.ungroup(tabId);
		} catch {
			/* tab gone */
		}
		await this.persist();
	}

	async closeTab(tabId: number): Promise<void> {
		if (!this.state.tabIds.includes(tabId)) throw new Error(`Tab ${tabId} is not owned by this session`);
		await this.release(tabId);
		try {
			await chrome.tabs.remove(tabId);
		} catch {
			/* already closed */
		}
	}

	/** Make an owned tab the one tools act on. Does not focus anything. */
	async setCurrent(tabId: number): Promise<chrome.tabs.Tab> {
		if (!this.state.tabIds.includes(tabId)) throw new Error(`Tab ${tabId} is not owned by this session`);
		const tab = await tabExists(tabId);
		if (!tab) {
			await this.reconcile();
			throw new Error(`Tab ${tabId} no longer exists`);
		}
		this.state.currentTabId = tabId;
		await this.persist();
		return tab;
	}

	/** The tab tools act on, or undefined when the session has no tabs yet. */
	async currentTab(): Promise<chrome.tabs.Tab | undefined> {
		if (this.state.currentTabId === undefined) return undefined;
		const tab = await tabExists(this.state.currentTabId);
		if (!tab) {
			await this.reconcile();
			return this.state.currentTabId === undefined ? undefined : await tabExists(this.state.currentTabId);
		}
		return tab;
	}

	/**
	 * Current tab for tools that need a page. An empty session does not get a blank tab
	 * conjured up (those piled up as empty tabs); the model is told to navigate first.
	 */
	async requireCurrentTab(): Promise<chrome.tabs.Tab> {
		const tab = await this.currentTab();
		if (tab) return tab;
		throw new NoTabError();
	}

	/** Current tab with the debugger attached, for CDP-based tools. */
	async attachedCurrentTab(): Promise<chrome.tabs.Tab> {
		const tab = await this.requireCurrentTab();
		if (tab.id === undefined) throw new Error("Tab has no id");
		if (tab.url && isRestrictedUrl(tab.url)) {
			throw new Error(
				`Cannot control ${tab.url}: browser-internal pages are protected. Navigate to a website first.`,
			);
		}
		await ensureAttached(tab.id);
		return tab;
	}

	/** Owned tabs with live titles and urls. */
	async tabs(): Promise<TabInfo[]> {
		await this.reconcile();
		const out: TabInfo[] = [];
		for (const id of this.state.tabIds) {
			const tab = await tabExists(id);
			if (!tab) continue;
			out.push({
				id,
				url: tab.url ?? tab.pendingUrl ?? "",
				title: tab.title ?? "",
				current: id === this.state.currentTabId,
				favicon: tab.favIconUrl,
				inGroup: this.state.groupId !== undefined && tab.groupId === this.state.groupId,
			});
		}
		return out;
	}

	/** The one focus-changing operation: bring an owned tab to the front for the user. */
	async show(tabId?: number): Promise<void> {
		const id = tabId ?? this.state.currentTabId;
		if (id === undefined) return;
		if (!this.state.tabIds.includes(id)) throw new Error(`Tab ${id} is not owned by this session`);
		const tab = await tabExists(id);
		if (!tab) return;
		await releaseAgentViewport(id);
		await chrome.tabs.update(id, { active: true });
		await chrome.windows.update(tab.windowId, { focused: true });
	}

	/** Detach debuggers but keep the record, so a reconnecting client re-adopts its tabs. */
	async suspend(): Promise<void> {
		for (const id of this.state.tabIds) await detachTab(id);
	}

	/** Detach debuggers and forget the session; tabs stay open for the user. */
	async close(): Promise<void> {
		for (const id of this.state.tabIds) await detachTab(id, true);
		const table = await readTable();
		delete table[this.state.id];
		await writeTable(table);
		instances.delete(this.state.id);
	}
}

async function lastFocusedWindowId(): Promise<number> {
	try {
		const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
		if (win.id !== undefined) return win.id;
	} catch {
		/* no window */
	}
	const win = await chrome.windows.create({ url: "about:blank", focused: false, type: "normal" });
	if (win?.id === undefined) throw new Error("Failed to create a window");
	return win.id;
}
