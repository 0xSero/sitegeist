import type { RecordingEvent, RecordingEventType } from "./recording/types.js";

declare global {
	interface Window {
		__sitegeistRecording?: boolean;
		__sitegeistRecordingCleanup?: () => void;
	}
}

(() => {
	if (window.__sitegeistRecording) return;
	window.__sitegeistRecording = true;

	const OVERLAY_ROOT_ID = "sitegeist-overlay-root";
	const SCROLL_THROTTLE_MS = 1000;
	const SCROLL_DELTA_MIN = 200;
	const MUTATION_DEBOUNCE_MS = 500;

	let lastScrollY = window.scrollY;
	let lastScrollTime = 0;
	let mutationBatchTimer: ReturnType<typeof setTimeout> | null = null;
	let mutationBatch = { added: 0, removed: 0, attributes: 0, target: "" };

	const isInsideOverlay = (el: Element | null): boolean => !!el?.closest(`#${OVERLAY_ROOT_ID}`);
	const getSelector = (el: Element): string => {
		if (el.id) return `#${el.id}`;
		const tag = el.tagName.toLowerCase();
		const cls = Array.from(el.classList).slice(0, 2).join(".");
		return cls ? `${tag}.${cls}` : tag;
	};

	const sendEvent = (event: RecordingEvent) => {
		try {
			void chrome.runtime.sendMessage({ type: "recording_event", event });
		} catch {}
	};

	const buildBase = (type: RecordingEventType): RecordingEvent => ({
		type,
		timestamp: Date.now(),
		url: location.href,
	});

	const onClickCapture = (e: MouseEvent) => {
		const target = e.target as Element | null;
		if (!target || isInsideOverlay(target)) return;
		sendEvent({
			...buildBase("click"),
			selector: getSelector(target),
			tagName: target.tagName.toLowerCase(),
			textContent: (target.textContent || "").trim().slice(0, 100),
			position: { x: Math.round(e.clientX), y: Math.round(e.clientY) },
		});
	};

	const onScroll = () => {
		const now = Date.now();
		if (now - lastScrollTime < SCROLL_THROTTLE_MS) return;
		const currentY = window.scrollY;
		const delta = currentY - lastScrollY;
		if (Math.abs(delta) < SCROLL_DELTA_MIN) return;
		lastScrollTime = now;
		lastScrollY = currentY;
		sendEvent({
			...buildBase("scroll"),
			scrollY: Math.round(currentY),
			direction: delta > 0 ? "down" : "up",
		});
	};

	const onInputCapture = (e: Event) => {
		const target = e.target as HTMLInputElement | HTMLTextAreaElement | null;
		if (!target || isInsideOverlay(target)) return;
		sendEvent({
			...buildBase("input"),
			selector: getSelector(target),
			tagName: target.tagName.toLowerCase(),
			inputType: (target as HTMLInputElement).type || "text",
			placeholder: (target.placeholder || "").slice(0, 100),
		});
	};

	const flushMutations = () => {
		if (mutationBatch.added === 0 && mutationBatch.removed === 0 && mutationBatch.attributes === 0) return;
		sendEvent({
			...buildBase("dom_mutation"),
			summary: `+${mutationBatch.added} nodes, -${mutationBatch.removed} nodes, ${mutationBatch.attributes} attr changes in ${mutationBatch.target}`,
			addedCount: mutationBatch.added,
			removedCount: mutationBatch.removed,
			attributeChanges: mutationBatch.attributes,
		});
		mutationBatch = { added: 0, removed: 0, attributes: 0, target: "" };
	};

	const observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (isInsideOverlay(mutation.target as Element)) continue;
			if (mutation.type === "childList") {
				mutationBatch.added += mutation.addedNodes.length;
				mutationBatch.removed += mutation.removedNodes.length;
			} else if (mutation.type === "attributes") {
				mutationBatch.attributes += 1;
			}
			if (!mutationBatch.target && mutation.target instanceof Element) {
				mutationBatch.target = getSelector(mutation.target);
			}
		}
		if (mutationBatchTimer) clearTimeout(mutationBatchTimer);
		mutationBatchTimer = setTimeout(flushMutations, MUTATION_DEBOUNCE_MS);
	});

	const originalPushState = history.pushState;
	const originalReplaceState = history.replaceState;
	const onNavigation = (fromUrl: string, toUrl: string, trigger: string) => {
		if (fromUrl === toUrl) return;
		sendEvent({ ...buildBase("navigation"), fromUrl, toUrl, trigger });
	};

	history.pushState = function (...args: Parameters<typeof history.pushState>) {
		const fromUrl = location.href;
		originalPushState.apply(this, args);
		onNavigation(fromUrl, location.href, "pushState");
	};

	history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
		const fromUrl = location.href;
		originalReplaceState.apply(this, args);
		onNavigation(fromUrl, location.href, "replaceState");
	};

	const onPopState = () => onNavigation("", location.href, "popstate");
	const onMessage = (message: unknown) => {
		if ((message as { type?: string })?.type === "recording_content_stop") cleanup();
	};

	const cleanup = () => {
		document.removeEventListener("click", onClickCapture, { capture: true } as EventListenerOptions);
		document.removeEventListener("scroll", onScroll);
		document.removeEventListener("input", onInputCapture, { capture: true } as EventListenerOptions);
		window.removeEventListener("popstate", onPopState);
		chrome.runtime.onMessage.removeListener(onMessage);
		observer.disconnect();
		if (mutationBatchTimer) clearTimeout(mutationBatchTimer);
		flushMutations();
		history.pushState = originalPushState;
		history.replaceState = originalReplaceState;
		window.__sitegeistRecording = false;
		window.__sitegeistRecordingCleanup = undefined;
	};

	document.addEventListener("click", onClickCapture, { capture: true });
	document.addEventListener("scroll", onScroll, { passive: true });
	document.addEventListener("input", onInputCapture, { capture: true });
	window.addEventListener("popstate", onPopState);
	chrome.runtime.onMessage.addListener(onMessage);
	observer.observe(document.body || document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
	});
	window.__sitegeistRecordingCleanup = cleanup;
})();
