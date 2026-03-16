export type RecordingEventType = "click" | "scroll" | "input" | "navigation" | "dom_mutation";

export type RecordingEvent = {
	type: RecordingEventType;
	timestamp: number;
	url: string;
	selector?: string;
	tagName?: string;
	textContent?: string;
	position?: { x: number; y: number };
	scrollY?: number;
	direction?: "up" | "down";
	inputType?: string;
	placeholder?: string;
	fromUrl?: string;
	toUrl?: string;
	trigger?: string;
	summary?: string;
	addedCount?: number;
	removedCount?: number;
	attributeChanges?: number;
};

export type RecordingScreenshot = {
	id: string;
	timestamp: number;
	dataUrl: string;
	url: string;
	index: number;
};

export type RecordingStatus = "idle" | "recording" | "selecting" | "ready";

export type RecordingState = {
	status: RecordingStatus;
	tabId: number;
	startedAt: number;
	elapsedMs: number;
	screenshotCount: number;
	eventCount: number;
};

export type RecordedContext = {
	id: string;
	createdAt: number;
	duration: number;
	selectedImages: Array<{ dataUrl: string; timestamp: number; url: string; index: number }>;
	events: RecordingEvent[];
	urlTimeline: Array<{ url: string; timestamp: number }>;
	summary: string;
};
