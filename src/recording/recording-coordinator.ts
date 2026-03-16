import {
	isRestrictedRecordingUrl,
	MAX_DURATION_MS,
	MAX_SCREENSHOTS,
	SCREENSHOT_INTERVAL_MS,
	shouldSkipInlineRecordingEvent,
} from "./recording-rules.js";
import {
	buildRecordingUrlTimeline,
	deduplicateRecordingEvents,
	generateRecordingSummary,
} from "./recording-summary.js";
import type { RecordedContext, RecordingEvent, RecordingScreenshot, RecordingState } from "./types.js";

export class RecordingCoordinator {
	state: RecordingState | null = null;
	screenshotBuffer: RecordingScreenshot[] = [];
	eventBuffer: RecordingEvent[] = [];
	private screenshotTimer: ReturnType<typeof setInterval> | null = null;
	private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
	private tickTimer: ReturnType<typeof setInterval> | null = null;

	async startRecording(tabId?: number): Promise<void> {
		if (this.state?.status === "recording") throw new Error("Already recording");

		let resolvedTabId = tabId;
		if (!resolvedTabId) {
			const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
			if (!activeTab?.id) throw new Error("No active tab found");
			resolvedTabId = activeTab.id;
		}

		const tab = await chrome.tabs.get(resolvedTabId);
		if (isRestrictedRecordingUrl(tab.url)) throw new Error("Cannot record on this page");

		this.screenshotBuffer = [];
		this.eventBuffer = [];
		this.state = {
			status: "recording",
			tabId: resolvedTabId,
			startedAt: Date.now(),
			elapsedMs: 0,
			screenshotCount: 0,
			eventCount: 0,
		};

		await chrome.scripting.executeScript({
			target: { tabId: resolvedTabId },
			files: ["content-recording.js"],
		});
		await this.captureScreenshot();

		this.screenshotTimer = setInterval(() => void this.captureScreenshot(), SCREENSHOT_INTERVAL_MS);
		this.tickTimer = setInterval(() => {
			if (!this.state) return;
			this.state.elapsedMs = Date.now() - this.state.startedAt;
			this.sendToSidePanel({
				type: "recording_tick",
				elapsedMs: this.state.elapsedMs,
				screenshotCount: this.state.screenshotCount,
				eventCount: this.state.eventCount,
			});
		}, 1000);
		this.maxDurationTimer = setTimeout(() => void this.stopRecording(), MAX_DURATION_MS);
	}

	async stopRecording(): Promise<void> {
		if (!this.state || this.state.status !== "recording") return;
		this.state.status = "selecting";
		this.state.elapsedMs = Date.now() - this.state.startedAt;
		this.clearTimers();

		try {
			await chrome.tabs.sendMessage(this.state.tabId, { type: "recording_content_stop" });
		} catch {}

		this.sendToSidePanel({
			type: "recording_complete",
			screenshots: this.screenshotBuffer,
			events: this.deduplicateEvents(),
		});
	}

	handleContentEvent(event: RecordingEvent): void {
		if (this.state?.status !== "recording") return;
		const lastEvent = this.eventBuffer[this.eventBuffer.length - 1];
		if (shouldSkipInlineRecordingEvent(lastEvent, event)) return;
		this.eventBuffer.push(event);
		this.state.eventCount = this.eventBuffer.length;
	}

	async selectImages(selectedIds: string[]): Promise<RecordedContext> {
		if (!this.state) throw new Error("No active recording session");

		const selected = this.screenshotBuffer
			.filter((screenshot) => selectedIds.includes(screenshot.id))
			.map((screenshot) => ({
				dataUrl: screenshot.dataUrl,
				timestamp: screenshot.timestamp,
				url: screenshot.url,
				index: screenshot.index,
			}));

		const events = this.deduplicateEvents();
		const urlTimeline = buildRecordingUrlTimeline(events);
		const summary = generateRecordingSummary(events, urlTimeline, selected.length);
		const context: RecordedContext = {
			id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			createdAt: Date.now(),
			duration: this.state.elapsedMs || 0,
			selectedImages: selected,
			events,
			urlTimeline,
			summary,
		};

		this.state = { ...this.state, status: "ready" };
		this.sendToSidePanel({ type: "recording_context_ready", context });
		return context;
	}

	discard(): void {
		this.clearTimers();
		this.screenshotBuffer = [];
		this.eventBuffer = [];
		this.state = null;
	}

	private async captureScreenshot(): Promise<void> {
		if (!this.state || this.state.status !== "recording") return;
		if (this.screenshotBuffer.length >= MAX_SCREENSHOTS) {
			await this.stopRecording();
			return;
		}

		try {
			const tab = await chrome.tabs.get(this.state.tabId);
			if (!tab.windowId) return;
			const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 50 });
			this.screenshotBuffer.push({
				id: `ss-${Date.now()}-${this.screenshotBuffer.length}`,
				timestamp: Date.now(),
				dataUrl,
				url: tab.url || "",
				index: this.screenshotBuffer.length,
			});
			this.state.screenshotCount = this.screenshotBuffer.length;
		} catch (error) {
			console.warn("[RecordingCoordinator] Screenshot capture failed:", error);
		}
	}

	private deduplicateEvents() {
		return deduplicateRecordingEvents(this.eventBuffer);
	}

	private sendToSidePanel(message: Record<string, unknown>): void {
		try {
			chrome.runtime.sendMessage(message);
		} catch {}
	}

	private clearTimers(): void {
		if (this.screenshotTimer) clearInterval(this.screenshotTimer);
		if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.screenshotTimer = null;
		this.maxDurationTimer = null;
		this.tickTimer = null;
	}
}
