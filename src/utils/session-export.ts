import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type ExportScope = "last-assistant" | "full-conversation";
export type ExportFormat = "markdown" | "json";

function toText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object") {
					const record = part as Record<string, unknown>;
					if (typeof record.text === "string") return record.text;
					if (record.type === "toolCall") {
						return `[tool call] ${String(record.name || "unknown")} ${JSON.stringify(record.arguments || {})}`;
					}
					if (record.type === "text") return String(record.text || "");
					return JSON.stringify(record, null, 2);
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	if (content && typeof content === "object") return JSON.stringify(content, null, 2);
	return String(content ?? "");
}

function getLastAssistantMessage(messages: AgentMessage[]) {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages[i];
	}
	return null;
}

export function buildExportPayload(
	messages: AgentMessage[],
	scope: ExportScope,
	title: string,
	sessionId?: string,
): unknown {
	if (scope === "last-assistant") {
		const last = getLastAssistantMessage(messages);
		return {
			scope,
			title,
			sessionId: sessionId || null,
			exportedAt: new Date().toISOString(),
			message: last,
		};
	}

	return {
		scope,
		title,
		sessionId: sessionId || null,
		exportedAt: new Date().toISOString(),
		messageCount: messages.length,
		messages,
	};
}

export function buildMarkdownExport(
	messages: AgentMessage[],
	scope: ExportScope,
	title: string,
	sessionId?: string,
): string {
	const chunks: string[] = [];
	chunks.push(`# ${scope === "last-assistant" ? "Last Response Export" : "Conversation Export"}`);
	chunks.push("");
	if (title) chunks.push(`- **Title:** ${title}`);
	if (sessionId) chunks.push(`- **Session ID:** ${sessionId}`);
	chunks.push(`- **Exported:** ${new Date().toLocaleString()}`);
	chunks.push("");

	const selectedMessages =
		scope === "last-assistant"
			? (() => {
					const last = getLastAssistantMessage(messages);
					return last ? [last] : [];
				})()
			: messages;

	for (const message of selectedMessages) {
		chunks.push(`## ${message.role}`);
		chunks.push("");
		if ((message as { toolName?: string }).toolName) {
			chunks.push(`- **Tool:** ${(message as { toolName?: string }).toolName}`);
			chunks.push("");
		}
		if ((message as { thinkingLevel?: string }).thinkingLevel) {
			chunks.push(`- **Thinking:** ${(message as { thinkingLevel?: string }).thinkingLevel}`);
			chunks.push("");
		}
		chunks.push(toText((message as { content?: unknown }).content) || "_No text content_");
		chunks.push("");
	}

	return chunks.join("\n");
}

export function downloadExport(content: string, filename: string, mimeType: string) {
	const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}
