import {
	CLICK_DEDUP_MS,
	EVENT_PRIORITY,
	INPUT_MERGE_MS,
	MAX_EVENTS,
	MUTATION_MERGE_MS,
	SCROLL_MERGE_MS,
} from "./recording-rules.js";
import type { RecordingEvent } from "./types.js";

export function deduplicateRecordingEvents(events: RecordingEvent[]): RecordingEvent[] {
	const merged: RecordingEvent[] = [];

	for (const current of events) {
		const previous = merged[merged.length - 1];
		if (!previous) {
			merged.push(current);
			continue;
		}

		const timeDiff = current.timestamp - previous.timestamp;

		if (current.type === "scroll" && previous.type === "scroll" && timeDiff < SCROLL_MERGE_MS) {
			previous.scrollY = current.scrollY;
			previous.direction = current.direction;
			continue;
		}

		if (
			current.type === "click" &&
			previous.type === "click" &&
			current.selector === previous.selector &&
			timeDiff < CLICK_DEDUP_MS
		) {
			continue;
		}

		if (
			current.type === "input" &&
			previous.type === "input" &&
			current.selector === previous.selector &&
			timeDiff < INPUT_MERGE_MS
		) {
			continue;
		}

		if (current.type === "dom_mutation" && previous.type === "dom_mutation" && timeDiff < MUTATION_MERGE_MS) {
			previous.addedCount = (previous.addedCount || 0) + (current.addedCount || 0);
			previous.removedCount = (previous.removedCount || 0) + (current.removedCount || 0);
			previous.attributeChanges = (previous.attributeChanges || 0) + (current.attributeChanges || 0);
			previous.summary = `+${previous.addedCount} nodes, -${previous.removedCount} nodes, ${previous.attributeChanges} attr changes`;
			continue;
		}

		merged.push(current);
	}

	if (merged.length <= MAX_EVENTS) return merged;

	return [...merged]
		.sort((a, b) => (EVENT_PRIORITY[b.type] || 0) - (EVENT_PRIORITY[a.type] || 0))
		.slice(0, MAX_EVENTS)
		.sort((a, b) => a.timestamp - b.timestamp);
}

export function buildRecordingUrlTimeline(events: RecordingEvent[]): Array<{ url: string; timestamp: number }> {
	const timeline: Array<{ url: string; timestamp: number }> = [];
	const seen = new Set<string>();

	for (const event of events) {
		if (event.type === "navigation" && event.toUrl && !seen.has(event.toUrl)) {
			seen.add(event.toUrl);
			timeline.push({ url: event.toUrl, timestamp: event.timestamp });
		}
	}

	if (events.length > 0 && !seen.has(events[0].url)) {
		timeline.unshift({ url: events[0].url, timestamp: events[0].timestamp });
	}

	return timeline;
}

export function generateRecordingSummary(
	events: RecordingEvent[],
	urlTimeline: Array<{ url: string; timestamp: number }>,
	imageCount: number,
): string {
	const clicks = events.filter((event) => event.type === "click");
	const inputs = events.filter((event) => event.type === "input");
	const scrolls = events.filter((event) => event.type === "scroll");
	const navigations = events.filter((event) => event.type === "navigation");

	const lines: string[] = [`[Recorded context: ${imageCount} screenshots, ${events.length} events]`];

	if (urlTimeline.length > 0) {
		lines.push(`Pages visited: ${urlTimeline.map((entry) => entry.url).join(" -> ")}`);
	}

	if (clicks.length > 0) {
		const targets = clicks
			.slice(0, 5)
			.map((event) => event.textContent || event.selector || event.tagName || "element");
		lines.push(`Clicked: ${targets.join(", ")}${clicks.length > 5 ? ` (+${clicks.length - 5} more)` : ""}`);
	}

	if (inputs.length > 0) {
		const fields = inputs.slice(0, 3).map((event) => event.placeholder || event.selector || "field");
		lines.push(`Typed in: ${fields.join(", ")}${inputs.length > 3 ? ` (+${inputs.length - 3} more)` : ""}`);
	}

	if (navigations.length > 0) lines.push(`Navigated ${navigations.length} time(s)`);
	if (scrolls.length > 0) lines.push(`Scrolled ${scrolls.length} time(s)`);

	return lines.join("\n");
}
