/**
 * Script injection that works with or without the `userScripts` API.
 *
 * Chromium gates `chrome.userScripts` behind the "Allow User Scripts" toggle even when
 * the optional permission was granted, and Manifest V3 forbids eval in isolated
 * content-script worlds, so arbitrary code strings can only run in two ways:
 *
 * 1. `userScripts.execute` when the toggle is on (isolated world, our own CSP, real
 *    `chrome.runtime.sendMessage` messaging).
 * 2. The debugger's `Runtime.evaluate` in the page's main world otherwise. CSP does not
 *    apply to it. Messaging is provided by a CDP binding: injected code calls a local
 *    `chrome.runtime.sendMessage` shim that posts through the binding, and replies come
 *    back through `Runtime.evaluate`.
 *
 * Both paths run the same code; callers do not need to know which one is in use.
 */

import { cdpSend, ensureAttached } from "./cdp.js";

interface UserScriptsApi {
	configureWorld(config: { worldId: string; messaging?: boolean; csp?: string }): Promise<void>;
	execute(config: {
		js: Array<{ code: string }>;
		target: { tabId: number; allFrames?: boolean };
		world: "USER_SCRIPT";
		worldId?: string;
		injectImmediately?: boolean;
		executionId?: string;
	}): Promise<Array<{ result?: unknown; error?: unknown }>>;
	terminate?(tabId: number, executionId: string): Promise<void>;
}

export function userScriptsApi(): UserScriptsApi | undefined {
	const api = (chrome as unknown as { userScripts?: UserScriptsApi }).userScripts;
	return api && typeof api.execute === "function" ? api : undefined;
}

export function hasUserScripts(): boolean {
	return userScriptsApi() !== undefined;
}

const configuredWorlds = new Set<string>();

export interface InjectOptions {
	/** userScripts world id; ignored on the debugger path. */
	worldId?: string;
	/** userScripts world CSP; ignored on the debugger path. */
	csp?: string;
	/** Enables cancellation (userScripts.terminate or Runtime.terminateExecution). */
	executionId?: string;
}

/** Handles messages the injected code sends through the shim; set once per context. */
export type CdpMessageHandler = (message: Record<string, unknown>, tabId: number) => Promise<unknown>;
let cdpMessageHandler: CdpMessageHandler | undefined;

export function setCdpMessageHandler(handler: CdpMessageHandler): void {
	cdpMessageHandler = handler;
}

/**
 * Runtime providers per sandbox id, mirroring what the sandbox router holds for the
 * userScripts path. The debugger path has no chrome.runtime listener, so messages are
 * routed here: the first provider that responds wins.
 */
interface SandboxProvider {
	handleMessage?(message: unknown, respond: (response: unknown) => void): Promise<void>;
}
const sandboxProviders = new Map<string, SandboxProvider[]>();

export function registerSandboxProviders(sandboxId: string, providers: SandboxProvider[]): void {
	sandboxProviders.set(sandboxId, providers);
}

export function unregisterSandboxProviders(sandboxId: string): void {
	sandboxProviders.delete(sandboxId);
}

export async function dispatchToSandbox(message: Record<string, unknown>): Promise<unknown> {
	const sandboxId = message.sandboxId;
	if (typeof sandboxId !== "string") return undefined;
	const providers = sandboxProviders.get(sandboxId);
	if (!providers) return undefined;
	let response: unknown;
	let responded = false;
	const respond = (r: unknown) => {
		if (responded) return;
		responded = true;
		response = { ...(r as Record<string, unknown>), sandboxId };
	};
	for (const provider of providers) {
		if (provider.handleMessage) await provider.handleMessage(message, respond);
	}
	return response;
}

const BINDING = "__sitegeistSend";
const bindingReady = new Set<number>();
let bindingListenerInstalled = false;
const runningExecutions = new Map<string, number>();

function installBindingListener(): void {
	if (bindingListenerInstalled) return;
	bindingListenerInstalled = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		if (method !== "Runtime.bindingCalled" || source.tabId === undefined) return;
		const p = params as { name?: string; payload?: string } | undefined;
		if (p?.name !== BINDING || !p.payload) return;
		const tabId = source.tabId;
		let parsed: { id: number; message: Record<string, unknown> };
		try {
			parsed = JSON.parse(p.payload);
		} catch {
			return;
		}
		(async () => {
			let response: unknown;
			let error: string | undefined;
			try {
				response = cdpMessageHandler ? await cdpMessageHandler(parsed.message, tabId) : undefined;
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
			const expression = `window.__sitegeistReceive && window.__sitegeistReceive(${parsed.id}, ${JSON.stringify(
				response ?? null,
			)}, ${JSON.stringify(error ?? null)})`;
			await cdpSend(tabId, "Runtime.evaluate", { expression, returnByValue: true }).catch(() => undefined);
		})();
	});
	chrome.tabs.onRemoved.addListener((tabId) => bindingReady.delete(tabId));
	chrome.debugger.onDetach.addListener((source) => {
		if (source.tabId !== undefined) bindingReady.delete(source.tabId);
	});
}

async function ensureBinding(tabId: number): Promise<void> {
	installBindingListener();
	await ensureAttached(tabId);
	if (bindingReady.has(tabId)) return;
	await cdpSend(tabId, "Runtime.enable");
	await cdpSend(tabId, "Runtime.addBinding", { name: BINDING }).catch(() => undefined);
	bindingReady.add(tabId);
}

/**
 * Page-side shim, installed once per document: a promise registry plus a
 * `chrome.runtime.sendMessage` lookalike that posts through the CDP binding.
 */
const SHIM = `(() => {
	const w = window;
	if (!w.__sitegeistPending) {
		w.__sitegeistPending = new Map();
		w.__sitegeistSeq = 0;
		w.__sitegeistReceive = (id, response, error) => {
			const p = w.__sitegeistPending.get(id);
			if (!p) return;
			w.__sitegeistPending.delete(id);
			if (error) p.reject(new Error(error)); else p.resolve(response);
		};
	}
	if (!w.__sitegeistChrome) {
		w.__sitegeistChrome = {
			runtime: {
				id: "sitegeist",
				sendMessage: (message) => new Promise((resolve, reject) => {
					const id = ++w.__sitegeistSeq;
					w.__sitegeistPending.set(id, { resolve, reject });
					w.${BINDING}(JSON.stringify({ id, message }));
				}),
			},
		};
	}
})();`;

async function cdpInject<T>(tabId: number, code: string, options: InjectOptions): Promise<T> {
	await ensureBinding(tabId);
	// `chrome` inside the injected code resolves to the shim; the page's own window.chrome is untouched.
	const expression = `${SHIM}\n(async () => { const chrome = window.__sitegeistChrome; return await (${code}); })()`;
	if (options.executionId) runningExecutions.set(options.executionId, tabId);
	try {
		const result = await cdpSend<{
			result: { value?: T; description?: string };
			exceptionDetails?: { exception?: { description?: string }; text?: string };
		}>(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) {
			throw new Error(
				result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed",
			);
		}
		return result.result.value as T;
	} finally {
		if (options.executionId) runningExecutions.delete(options.executionId);
	}
}

/**
 * Run `code` (an expression or IIFE, may return a promise) in the page and return
 * its value, matching userScripts.execute's `results[0].result`.
 */
export async function injectScript<T = unknown>(tabId: number, code: string, options: InjectOptions = {}): Promise<T> {
	const api = userScriptsApi();
	if (!api) return cdpInject<T>(tabId, code, options);
	const worldId = options.worldId ?? "sitegeist";
	if (!configuredWorlds.has(worldId)) {
		try {
			await api.configureWorld({ worldId, messaging: true, csp: options.csp });
		} catch {
			/* already configured */
		}
		configuredWorlds.add(worldId);
	}
	const results = await api.execute({
		js: [{ code }],
		target: { tabId, allFrames: false },
		world: "USER_SCRIPT",
		worldId,
		injectImmediately: true,
		...(options.executionId && api.terminate ? { executionId: options.executionId } : {}),
	});
	const first = results[0];
	if (first?.error) throw new Error(String((first.error as { message?: string }).message ?? first.error));
	return first?.result as T;
}

/** Cancel a running injection on either path. */
export async function terminateInjection(tabId: number, executionId: string): Promise<boolean> {
	const api = userScriptsApi();
	if (api?.terminate) {
		await api.terminate(tabId, executionId);
		return true;
	}
	if (runningExecutions.has(executionId)) {
		await cdpSend(tabId, "Runtime.terminateExecution").catch(() => undefined);
		return true;
	}
	return false;
}

export function supportsTermination(): boolean {
	return true;
}
