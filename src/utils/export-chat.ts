/**
 * Export the current conversation to a downloadable file (Markdown or JSON).
 *
 * Messages come straight from `agent.state.messages`, which is a mix of the
 * pi-agent-core message roles (user / assistant / toolResult) plus the custom
 * sitegeist roles (navigation / welcome / user-with-attachments).
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";

function downloadBlob(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

function slugify(title: string): string {
	const base = (title || "chat")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return base || "chat";
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as any[]) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && block.text) parts.push(block.text);
		else if (block.type === "image") parts.push("_[image]_");
	}
	return parts.join("\n");
}

/** Serialize a conversation to readable Markdown. */
export function chatToMarkdown(messages: AgentMessage[], title: string, model?: Model<any>): string {
	const lines: string[] = [];
	lines.push(`# ${title || "Sitegeist chat"}`);
	lines.push("");
	const meta: string[] = [`Exported: ${new Date().toLocaleString()}`];
	if (model) meta.push(`Model: ${model.provider}/${model.id}`);
	lines.push(`_${meta.join(" · ")}_`);
	lines.push("");

	for (const msg of messages as any[]) {
		switch (msg.role) {
			case "welcome":
				break;
			case "navigation":
				lines.push(`> Navigated to ${msg.title ? `**${msg.title}** — ` : ""}${msg.url}`);
				lines.push("");
				break;
			case "user":
			case "user-with-attachments": {
				const text = textFromContent(msg.content);
				lines.push("## User");
				lines.push("");
				if (text.trim()) lines.push(text.trim());
				const attachments = msg.attachments as { name?: string }[] | undefined;
				if (attachments?.length) {
					lines.push("");
					lines.push(`_Attachments: ${attachments.map((a) => a.name || "file").join(", ")}_`);
				}
				lines.push("");
				break;
			}
			case "assistant": {
				lines.push("## Assistant");
				lines.push("");
				for (const block of (msg.content as any[]) || []) {
					if (!block || typeof block !== "object") continue;
					if (block.type === "text" && block.text) {
						lines.push(block.text);
						lines.push("");
					} else if (block.type === "thinking" && block.thinking) {
						lines.push("<details><summary>Thinking</summary>");
						lines.push("");
						lines.push(block.thinking);
						lines.push("");
						lines.push("</details>");
						lines.push("");
					} else if (block.type === "toolCall") {
						const args = JSON.stringify(block.arguments ?? {}, null, 2);
						lines.push(`**Tool call:** \`${block.name}\``);
						lines.push("");
						lines.push("```json");
						lines.push(args);
						lines.push("```");
						lines.push("");
					}
				}
				break;
			}
			case "toolResult": {
				const text = textFromContent(msg.content);
				if (text.trim()) {
					const truncated = text.length > 2000 ? `${text.slice(0, 2000)}\n… (truncated)` : text;
					lines.push(
						`<details><summary>Tool result: ${msg.toolName || "tool"}${msg.isError ? " (error)" : ""}</summary>`,
					);
					lines.push("");
					lines.push("```");
					lines.push(truncated);
					lines.push("```");
					lines.push("");
					lines.push("</details>");
					lines.push("");
				}
				break;
			}
			default:
				break;
		}
	}

	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()}\n`;
}

/** Download the conversation as a Markdown file. */
export function downloadChatMarkdown(messages: AgentMessage[], title: string, model?: Model<any>) {
	const md = chatToMarkdown(messages, title, model);
	const date = new Date().toISOString().split("T")[0];
	downloadBlob(new Blob([md], { type: "text/markdown" }), `${slugify(title)}-${date}.md`);
}

/** Download the conversation as raw JSON (full fidelity, re-importable). */
export function downloadChatJson(messages: AgentMessage[], title: string, model?: Model<any>) {
	const payload = {
		title,
		exportedAt: new Date().toISOString(),
		model: model ? { provider: model.provider, id: model.id } : undefined,
		messages,
	};
	const date = new Date().toISOString().split("T")[0];
	downloadBlob(
		new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
		`${slugify(title)}-${date}.json`,
	);
}
