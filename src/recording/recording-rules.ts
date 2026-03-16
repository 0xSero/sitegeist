import type { RecordingEvent } from "./types.js";

export const MAX_DURATION_MS = 60_000;
export const SCREENSHOT_INTERVAL_MS = 3_000;
export const MAX_SCREENSHOTS = 20;
export const MAX_EVENTS = 100;
const RESTRICTED_URL_PATTERN = /^(chrome|chrome-extension|edge|about|devtools|file):/;

export const CLICK_DEDUP_MS = 500;
export const SCROLL_MERGE_MS = 2_000;
export const INPUT_MERGE_MS = 1_000;
export const MUTATION_MERGE_MS = 1_000;

export const EVENT_PRIORITY: Record<string, number> = {
	navigation: 5,
	click: 4,
	input: 3,
	dom_mutation: 2,
	scroll: 1,
};

export function isRestrictedRecordingUrl(url: string | null | undefined) {
	return !url || RESTRICTED_URL_PATTERN.test(url);
}

export function shouldSkipInlineRecordingEvent(
	lastEvent: RecordingEvent | undefined,
	nextEvent: RecordingEvent,
): boolean {
	if (!lastEvent || lastEvent.type !== nextEvent.type || lastEvent.selector !== nextEvent.selector) {
		return false;
	}
	const timeDiff = nextEvent.timestamp - lastEvent.timestamp;
	if (nextEvent.type === "click" && timeDiff < CLICK_DEDUP_MS) return true;
	if (nextEvent.type === "input" && timeDiff < INPUT_MERGE_MS) return true;
	return false;
}
