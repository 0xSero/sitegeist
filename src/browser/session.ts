/**
 * BrowserSession: the set of tabs an agent owns.
 *
 * Every agent (a sidepanel chat session or an external harness connected through
 * the bridge) gets one session. The session owns a Chrome tab group in one window,
 * creates its tabs inactive, tracks which tab tools act on, and never touches tabs
 * outside the group. Nothing here changes window focus or the active tab; that is
 * reserved for the explicit `show()` call.
 *
 * State is mirrored to chrome.storage.session so it survives sidepanel reloads and
 * service worker restarts. It is cleared when the browser exits, which is when the
 * tabs are gone too.
 */

import { detachTab, ensureAttached, isRestrictedUrl } from "./cdp.js";

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
}

interface PersistedSession {
	id: string;
	label: string;
	color: `${chrome.tabGroups.Color}`;
	windowId: number;
	groupId?: number;
	tabIds: number[];
	currentTabId?: number;
}

type SessionTable = Record<string, PersistedSession>;

async function readTable(): Promise<SessionTable> {
	const data = await chrome.storage.session.get(STORAGE_KEY);
	return (data[STORAGE_KEY] as SessionTable | undefined) ?? {};
}

async function writeTable(table: SessionTable): Promise<void> {
	await chrome.storage.session.set({ [STORAGE_KEY]: table });
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
				label,
				color: pickColor(table),
				windowId: windowId ?? (await lastFocusedWindowId()),
				tabIds: [],
			};
		} else {
			state.label = label;
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
		if (this.state.groupId !== undefined) {
			try {
				await chrome.tabGroups.get(this.state.groupId);
			} catch {
				this.state.groupId = undefined;
			}
		}
		if (this.state.groupId === undefined && alive.length === 0) {
			const found = await chrome.tabGroups.query({ title: this.groupTitle() });
			if (found[0]?.id !== undefined) this.state.groupId = found[0].id;
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

	/** Put a tab into the session group, creating the group in the session window. */
	private async groupTab(tabId: number): Promise<void> {
		try {
			if (this.state.groupId !== undefined) {
				try {
					await chrome.tabGroups.get(this.state.groupId);
				} catch {
					this.state.groupId = undefined;
				}
			}
			if (this.state.groupId !== undefined) {
				await chrome.tabs.group({ tabIds: [tabId], groupId: this.state.groupId });
			} else {
				const tab = await chrome.tabs.get(tabId);
				this.state.groupId = await chrome.tabs.group({
					tabIds: [tabId],
					createProperties: { windowId: tab.windowId },
				});
				await chrome.tabGroups.update(this.state.groupId, { title: this.groupTitle(), color: this.state.color });
			}
		} catch (err) {
			// Grouping is cosmetic; a pinned tab or a closing window must not fail the tool.
			console.warn("[BrowserSession] group failed:", err);
		}
	}

	/** Create a new inactive tab in the session window and make it current. */
	async createTab(url?: string): Promise<chrome.tabs.Tab> {
		let windowId = this.state.windowId;
		try {
			await chrome.windows.get(windowId);
		} catch {
			windowId = await lastFocusedWindowId();
			this.state.windowId = windowId;
		}
		const tab = await chrome.tabs.create({ url: url ?? "about:blank", windowId, active: false });
		if (tab.id === undefined) throw new Error("Failed to create tab");
		await this.adopt(tab.id);
		return tab;
	}

	/** Take ownership of an existing tab (user handed it over, or a popup opened from an owned tab). */
	async adopt(tabId: number, makeCurrent = true): Promise<void> {
		if (!this.state.tabIds.includes(tabId)) this.state.tabIds.push(tabId);
		if (makeCurrent) this.state.currentTabId = tabId;
		await this.groupTab(tabId);
		await this.persist();
	}

	/** Release a tab without closing it. */
	async release(tabId: number): Promise<void> {
		this.state.tabIds = this.state.tabIds.filter((id) => id !== tabId);
		if (this.state.currentTabId === tabId) this.state.currentTabId = this.state.tabIds[this.state.tabIds.length - 1];
		await detachTab(tabId);
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
	 * Current tab, creating one when the session is empty. Tools that need a page
	 * call this; a fresh session then starts on about:blank instead of failing.
	 */
	async requireCurrentTab(): Promise<chrome.tabs.Tab> {
		const tab = await this.currentTab();
		if (tab) return tab;
		return this.createTab();
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
		await chrome.tabs.update(id, { active: true });
		await chrome.windows.update(tab.windowId, { focused: true });
	}

	/** Detach debuggers but keep the record, so a reconnecting client re-adopts its tabs. */
	async suspend(): Promise<void> {
		for (const id of this.state.tabIds) await detachTab(id);
	}

	/** Detach debuggers and forget the session; tabs stay open for the user. */
	async close(): Promise<void> {
		for (const id of this.state.tabIds) await detachTab(id);
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
