/**
 * Lightweight interaction recorder.
 *
 * Ported, simplified, from the parchi/browser-ai "record" feature: capture the
 * user's clicks, inputs, form submits and navigations on the active tab, then
 * turn them into a site-scoped Sitegeist Skill. Because the generated skill's
 * `domainPatterns` is the recorded host, the agent automatically sees the skill
 * id when on that site (via the navigate/skill URL matching) and can retrieve
 * and replay it.
 */

import type { Skill } from "../storage/stores/skills-store.js";

export interface RecordedStep {
	type: "click" | "input" | "submit" | "navigate";
	selector?: string;
	tag?: string;
	text?: string;
	value?: string;
	url?: string;
	timestamp: number;
}

export interface RecordingResult {
	hostname: string;
	startUrl: string;
	steps: RecordedStep[];
	screenshots: string[];
}

const RECORD_EVENT = "sitegeist-record-event";

function isRestrictedUrl(url: string): boolean {
	return (
		url.startsWith("chrome://") ||
		url.startsWith("chrome-extension://") ||
		url.startsWith("moz-extension://") ||
		url.startsWith("edge://") ||
		url.startsWith("brave://") ||
		url.startsWith("about:") ||
		url.startsWith("https://chrome.google.com/webstore")
	);
}

/**
 * Injected into the page (isolated world) to capture interactions and stream
 * them back to the side panel. Must be fully self-contained.
 */
function injectedRecorder() {
	const w = window as any;
	if (w.__sitegeistRecorderActive) return;
	w.__sitegeistRecorderActive = true;

	const RECORD_EVENT = "sitegeist-record-event";
	const send = (step: any) => {
		try {
			chrome.runtime.sendMessage({ type: RECORD_EVENT, step });
		} catch {
			/* side panel may be closed */
		}
	};

	const cssPath = (start: Element): string => {
		if (!(start instanceof Element)) return "";
		if (start.id) return `#${CSS.escape(start.id)}`;
		const parts: string[] = [];
		let node: Element | null = start;
		while (node && node.nodeType === 1 && parts.length < 6) {
			if (node.id) {
				parts.unshift(`#${CSS.escape(node.id)}`);
				break;
			}
			let sel = node.tagName.toLowerCase();
			const cls = Array.from(node.classList)
				.filter((c) => !!c && c.length < 30)
				.slice(0, 2)
				.map((c) => `.${CSS.escape(c)}`)
				.join("");
			sel += cls;
			const parent: Element | null = node.parentElement;
			if (parent) {
				const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
				if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
			}
			parts.unshift(sel);
			node = node.parentElement;
		}
		return parts.join(" > ");
	};

	const onClick = (e: Event) => {
		const target = e.target as Element | null;
		if (!target) return;
		const el = (target.closest("a,button,input,select,textarea,[role=button],[onclick],label") as Element) || target;
		send({
			type: "click",
			selector: cssPath(el),
			tag: el.tagName.toLowerCase(),
			text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
			timestamp: Date.now(),
		});
	};

	const onChange = (e: Event) => {
		const el = e.target as HTMLInputElement | null;
		if (!el) return;
		const tag = el.tagName.toLowerCase();
		if (tag !== "input" && tag !== "textarea" && tag !== "select") return;
		const type = (el.getAttribute("type") || "").toLowerCase();
		const sensitive = type === "password";
		send({
			type: "input",
			selector: cssPath(el),
			tag,
			value: sensitive ? "" : (el.value || "").slice(0, 300),
			timestamp: Date.now(),
		});
	};

	const onSubmit = (e: Event) => {
		const el = e.target as Element | null;
		if (!el) return;
		send({ type: "submit", selector: cssPath(el), tag: "form", timestamp: Date.now() });
	};

	document.addEventListener("click", onClick, true);
	document.addEventListener("change", onChange, true);
	document.addEventListener("submit", onSubmit, true);

	w.__sitegeistRecorderCleanup = () => {
		document.removeEventListener("click", onClick, true);
		document.removeEventListener("change", onChange, true);
		document.removeEventListener("submit", onSubmit, true);
		w.__sitegeistRecorderActive = false;
		w.__sitegeistRecorderCleanup = undefined;
	};
}

/** Collapse noisy consecutive events (repeated typing / double clicks). */
function dedupe(steps: RecordedStep[]): RecordedStep[] {
	const out: RecordedStep[] = [];
	for (const step of steps) {
		const prev = out[out.length - 1];
		if (prev && step.type === "input" && prev.type === "input" && prev.selector === step.selector) {
			out[out.length - 1] = step; // keep latest value for the same field
			continue;
		}
		if (
			prev &&
			step.type === "click" &&
			prev.type === "click" &&
			prev.selector === step.selector &&
			step.timestamp - prev.timestamp < 350
		) {
			continue; // de-bounce double clicks
		}
		if (prev && step.type === "navigate" && prev.type === "navigate" && prev.url === step.url) {
			continue;
		}
		out.push(step);
	}
	return out;
}

export class Recorder {
	active = false;
	private tabId?: number;
	private windowId?: number;
	hostname = "";
	startUrl = "";
	private steps: RecordedStep[] = [];
	private screenshots: string[] = [];
	private msgListener?: (msg: any, sender: chrome.runtime.MessageSender) => void;
	private navListener?: (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => void;

	async start(): Promise<void> {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		if (!tab?.id || !tab.url || isRestrictedUrl(tab.url)) {
			throw new Error("Cannot record this page");
		}
		this.tabId = tab.id;
		this.windowId = tab.windowId;
		this.startUrl = tab.url;
		this.hostname = new URL(tab.url).hostname;
		this.steps = [];
		this.screenshots = [];

		this.msgListener = (msg, sender) => {
			if (msg?.type === RECORD_EVENT && sender.tab?.id === this.tabId && msg.step) {
				this.steps.push(msg.step as RecordedStep);
			}
		};
		chrome.runtime.onMessage.addListener(this.msgListener);

		this.navListener = (details) => {
			if (details.tabId !== this.tabId || details.frameId !== 0) return;
			if (isRestrictedUrl(details.url)) return;
			this.steps.push({ type: "navigate", url: details.url, timestamp: Date.now() });
			// Page reloaded — re-inject the capture script.
			this.inject().catch(() => {});
			this.snapshot().catch(() => {});
		};
		chrome.webNavigation.onCompleted.addListener(this.navListener);

		await this.inject();
		await this.snapshot();
		this.active = true;
	}

	private async inject(): Promise<void> {
		if (this.tabId == null) return;
		await chrome.scripting.executeScript({
			target: { tabId: this.tabId },
			func: injectedRecorder,
		});
	}

	private async snapshot(): Promise<void> {
		if (this.windowId == null || this.screenshots.length >= 12) return;
		try {
			const dataUrl = await chrome.tabs.captureVisibleTab(this.windowId, { format: "jpeg", quality: 50 });
			if (dataUrl) this.screenshots.push(dataUrl);
		} catch {
			/* capture can fail on protected pages; ignore */
		}
	}

	async stop(): Promise<RecordingResult> {
		this.active = false;
		if (this.msgListener) chrome.runtime.onMessage.removeListener(this.msgListener);
		if (this.navListener) chrome.webNavigation.onCompleted.removeListener(this.navListener);
		await this.snapshot();
		if (this.tabId != null) {
			try {
				await chrome.scripting.executeScript({
					target: { tabId: this.tabId },
					func: () => {
						(window as any).__sitegeistRecorderCleanup?.();
					},
				});
			} catch {
				/* tab may be gone */
			}
		}
		return {
			hostname: this.hostname,
			startUrl: this.startUrl,
			steps: dedupe(this.steps),
			screenshots: this.screenshots,
		};
	}
}

/** Sanitize a skill name into a valid JS identifier for the page-injected global. */
export function toJsIdentifier(name: string): string {
	let id = name.replace(/[^a-zA-Z0-9_$]/g, "_").replace(/^[0-9]+/, "");
	if (!id) id = "recordedSkill";
	if (/^[0-9]/.test(id)) id = `_${id}`;
	return id;
}

function describeStep(step: RecordedStep, index: number): string {
	const n = index + 1;
	switch (step.type) {
		case "navigate":
			return `${n}. Navigate to ${step.url}`;
		case "click":
			return `${n}. Click ${step.text ? `"${step.text}" ` : ""}\`${step.selector}\``;
		case "input":
			return `${n}. Type ${step.value ? `"${step.value}"` : "(value)"} into \`${step.selector}\``;
		case "submit":
			return `${n}. Submit form \`${step.selector}\``;
		default:
			return `${n}. ${step.type}`;
	}
}

function generateReplayLibrary(jsName: string, steps: RecordedStep[]): string {
	const stepsJson = JSON.stringify(steps, null, 2);
	return `// Auto-generated from a recorded session. Runs inside browserjs() (page context).
// replay() performs the recorded DOM actions on the CURRENT page. Navigation
// steps are returned as 'skipped-navigation' — drive those with navigate() in
// the REPL between replay() calls, following window.${jsName}.steps in order.
window.${jsName} = {
  steps: ${stepsJson},
  async replay() {
    const results = [];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const setNativeValue = (el, value) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(el, value);
      else el.value = value;
    };
    for (const step of this.steps) {
      try {
        if (step.type === "navigate") {
          results.push({ step, status: "skipped-navigation", url: step.url });
          continue;
        }
        const el = step.selector ? document.querySelector(step.selector) : null;
        if (!el) {
          results.push({ step, status: "not-found" });
          continue;
        }
        if (step.type === "click") {
          el.click();
          results.push({ step, status: "clicked" });
        } else if (step.type === "input") {
          el.focus();
          setNativeValue(el, step.value || "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          results.push({ step, status: "typed" });
        } else if (step.type === "submit") {
          if (typeof el.requestSubmit === "function") el.requestSubmit();
          else if (typeof el.submit === "function") el.submit();
          results.push({ step, status: "submitted" });
        }
        await wait(300);
      } catch (e) {
        results.push({ step, status: "error", error: String(e) });
      }
    }
    return results;
  },
};`;
}

/** Build a Sitegeist Skill from a recording. */
export function buildSkillFromRecording(
	rec: RecordingResult,
	opts: { name: string; domainPatterns?: string[] },
): Skill {
	const name = opts.name.trim();
	const jsName = toJsIdentifier(name);
	const domainPatterns = opts.domainPatterns?.length ? opts.domainPatterns : [rec.hostname];
	const stepLines = rec.steps.map((s, i) => describeStep(s, i)).join("\n");
	const now = new Date().toISOString();

	const description = `# ${name}

Recorded workflow on **${rec.hostname}**. Replayable via \`browserjs()\`.

## Steps
${stepLines || "_(no steps captured)_"}

## Usage
The library exposes \`window.${jsName}\`. Call \`window.${jsName}.replay()\` inside \`browserjs()\` to perform the DOM actions on the current page. For \`navigate\` steps, use the REPL \`navigate()\` between replays, following \`window.${jsName}.steps\`.`;

	const examples = `// Replay the recorded "${name}" workflow on the current page
const report = await browserjs(async () => {
  return await window.${jsName}.replay();
});
console.log(report);`;

	return {
		name,
		domainPatterns,
		shortDescription: `Recorded workflow on ${rec.hostname} (${rec.steps.length} steps, replayable)`,
		description,
		examples,
		library: generateReplayLibrary(jsName, rec.steps),
		createdAt: now,
		lastUpdated: now,
	};
}
