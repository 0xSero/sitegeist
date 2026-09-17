import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { icon } from "@mariozechner/mini-lit";
import { Diff } from "@mariozechner/mini-lit/dist/Diff.js";
import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum, type ToolResultMessage } from "@mariozechner/pi-ai";
import {
	registerToolRenderer,
	renderCollapsibleHeader,
	renderHeader,
	SandboxIframe,
	type ToolRenderer,
	type ToolRenderResult,
} from "@mariozechner/pi-web-ui";
import { type Static, Type } from "@sinclair/typebox";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Sparkles } from "lucide";
import { getCurrentBrowserSession, hasCurrentBrowserSession } from "../browser/current.js";
import { DomainPill } from "../components/DomainPill.js";
import { SkillPill } from "../components/SkillPill.js";
import { SKILL_TOOL_DESCRIPTION } from "../prompts/prompts.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import type { Skill } from "../storage/stores/skills-store.js";
import { defaultSkills } from "./default-skills.js";

const getSkills = () => getSitegeistStorage().skills;

// Initialize default skills on first run
export async function initializeDefaultSkills() {
	const skillsRepo = getSkills();
	for (const skill of defaultSkills) {
		const existing = await skillsRepo.getSkill(skill.name);
		if (!existing) {
			await skillsRepo.saveSkill(skill);
		}
	}
}

// Get sandbox URL for CSP-compliant code validation
const getSandboxUrl = () => {
	return chrome.runtime.getURL("sandbox.html");
};

/**
 * Check if library code contains navigation attempts.
 * Returns { hasNavigation: false } or { hasNavigation: true, warning: string }
 */
function checkForNavigation(code: string): { hasNavigation: boolean; warning?: string } {
	// Library code runs inside browserjs() - ANY navigation will break execution
	// Navigation must be done in the REPL script using navigate() before calling browserjs()
	const navigationPatterns = [
		/window\.location\s*=/, // window.location = ...
		/window\.location\.\w+\s*=/, // window.location.href = ..., window.location.pathname = ...
		/window\.location\.(assign|replace|reload)\s*\(/, // window.location.assign(...), replace(...), reload()
		/\blocation\s*=/, // location = ...
		/\blocation\.\w+\s*=/, // location.href = ..., location.pathname = ...
		/\blocation\.(assign|replace|reload)\s*\(/, // location.assign(...), replace(...), reload()
		/\bnavigate\s*\(/, // navigate(...)
		/history\.(pushState|replaceState)\s*\(/, // history.pushState/replaceState
	];

	for (const pattern of navigationPatterns) {
		if (pattern.test(code)) {
			return {
				hasNavigation: true,
				warning:
					"Library code must NOT contain navigation logic. Library code runs inside browserjs() which breaks execution on navigation. Navigation must be performed in the REPL script by calling navigate() BEFORE calling browserjs().",
			};
		}
	}

	return { hasNavigation: false };
}

/**
 * Validate JavaScript syntax using sandboxed iframe (CSP-compliant).
 * Returns { valid: true } or { valid: false, error: string }
 */
async function validateJavaScriptSyntax(code: string): Promise<{ valid: boolean; error?: string }> {
	// First check for navigation attempts
	const navCheck = checkForNavigation(code);
	if (navCheck.hasNavigation) {
		return { valid: false, error: navCheck.warning };
	}

	const sandbox = new SandboxIframe();
	sandbox.sandboxUrlProvider = getSandboxUrl;
	sandbox.style.display = "none";
	document.body.appendChild(sandbox);

	try {
		const result = await sandbox.execute(`syntax-check-${Date.now()}`, code, []);
		sandbox.remove();

		if (!result.success && result.error) {
			return { valid: false, error: result.error.message };
		}

		return { valid: true };
	} catch (error: unknown) {
		sandbox.remove();
		return { valid: false, error: (error as Error).message || "Unknown error" };
	}
}

// IMPORTANT: Use StringEnum for Google API compatibility (NOT Type.Union!)
const skillParamsSchema = Type.Object({
	action: StringEnum(["get", "list", "create", "rewrite", "update", "delete"], {
		description: "Action to perform",
	}),
	name: Type.Optional(Type.String({ description: "Skill name (required for get/rewrite/update/delete)" })),
	url: Type.Optional(
		Type.String({
			description: "URL to filter skills by domain (optional for list action, defaults to current tab URL)",
		}),
	),
	includeLibraryCode: Type.Optional(
		Type.Boolean({
			description:
				"Use with 'get' action to include full library code in output (only necessary if you want to make changes to the library code of a skill)",
		}),
	),
	data: Type.Optional(
		Type.Object({
			name: Type.String({ description: "Unique skill name" }),
			domainPatterns: Type.Array(Type.String(), {
				description:
					"Array of glob patterns (e.g., ['youtube.com', 'youtu.be'] or ['github.com', 'github.com/*/issues']). Include short URLs and domain variations!",
			}),
			shortDescription: Type.String({
				description: "Brief one-line plain text description",
			}),
			description: Type.String({
				description: "Full markdown description (include gotchas/limitations, use markdown formatting)",
			}),
			examples: Type.String({
				description: "Plain JavaScript code examples (will be rendered in code block)",
			}),
			library: Type.String({ description: "JavaScript code to inject" }),
		}),
	),
	updates: Type.Optional(
		Type.Object({
			name: Type.Optional(
				Type.Object({
					old_string: Type.String({
						description: "String to find in skill name",
					}),
					new_string: Type.String({ description: "String to replace it with" }),
				}),
			),
			shortDescription: Type.Optional(
				Type.Object({
					old_string: Type.String({
						description: "String to find in short description",
					}),
					new_string: Type.String({ description: "String to replace it with" }),
				}),
			),
			domainPatterns: Type.Optional(
				Type.Object({
					old_string: Type.String({
						description: "String to find in domain patterns (searches across all patterns)",
					}),
					new_string: Type.String({ description: "String to replace it with" }),
				}),
			),
			library: Type.Optional(
				Type.Object({
					old_string: Type.String({
						description: "String to find in library code",
					}),
					new_string: Type.String({ description: "String to replace it with" }),
				}),
			),
			description: Type.Optional(
				Type.Object({
					old_string: Type.String({
						description: "String to find in description",
					}),
					new_string: Type.String({ description: "String to replace it with" }),
				}),
			),
			examples: Type.Optional(
				Type.Object({
					old_string: Type.String({
						description: "String to find in examples",
					}),
					new_string: Type.String({ description: "String to replace it with" }),
				}),
			),
		}),
	),
});

type SkillParams = Static<typeof skillParamsSchema>;

export const skillTool: AgentTool<typeof skillParamsSchema, any> = {
	label: "Skill Management",
	name: "skill",
	description: SKILL_TOOL_DESCRIPTION,
	parameters: skillParamsSchema,
	execute: async (_toolCallId: string, args: SkillParams) => {
		const skillsRepo = getSkills();
		const tab = hasCurrentBrowserSession() ? await getCurrentBrowserSession().currentTab() : undefined;
		const currentUrl = tab?.url || "";

		switch (args.action) {
			case "get": {
				if (!args.name) {
					throw new Error("Missing 'name' parameter for get action.");
				}

				const skill = await skillsRepo.getSkill(args.name);
				if (!skill) {
					// Return list of available skills for current domain
					const available = await skillsRepo.listSkills(currentUrl);
					if (available.length === 0) {
						throw new Error(`Skill '${args.name}' not found. No skills available for current domain.`);
					}
					const list = available.map((s) => `${s.name}: ${s.shortDescription}`).join("\n");
					throw new Error(`Skill '${args.name}' not found. Available skills:\n${list}`);
				}

				// Build output based on includeLibraryCode flag
				const domainsStr = skill.domainPatterns.join(", ");
				let llmOutput = `${skill.name} (${domainsStr})\n${skill.description}\n\nExamples:\n${skill.examples}`;

				// Only include library code if explicitly requested
				if (args.includeLibraryCode) {
					llmOutput += `\n\nLibrary:\n${skill.library}`;
				}

				return {
					content: [{ type: "text", text: llmOutput }],
					details: skill,
				};
			}

			case "list": {
				// Determine which URL to use for filtering
				// args.url === undefined -> use current tab URL (default)
				// args.url === "" -> list ALL skills (no filtering)
				// args.url === "https://..." -> use specified URL
				const filterUrl = args.url === undefined ? currentUrl : args.url === "" ? undefined : args.url;

				const skillList = await skillsRepo.listSkills(filterUrl);
				if (skillList.length === 0) {
					const msg = filterUrl ? "No skills found for specified domain." : "No skills found.";
					return { content: [{ type: "text", text: msg }], details: { skills: [] } };
				}

				// Token-efficient list for LLM: name: short description
				const llmOutput = skillList.map((s) => `${s.name}: ${s.shortDescription}`).join("\n");
				return {
					content: [{ type: "text", text: llmOutput }],
					details: { skills: skillList },
				};
			}

			case "create": {
				if (!args.data) {
					throw new Error("Missing 'data' parameter for create.");
				}

				// Check if already exists
				const existing = await skillsRepo.getSkill(args.data.name);
				if (existing) {
					throw new Error(`Skill '${args.data.name}' already exists. Use update action to modify.`);
				}

				const now = new Date().toISOString();
				const newSkill: Skill = {
					name: args.data.name,
					domainPatterns: args.data.domainPatterns,
					shortDescription: args.data.shortDescription,
					description: args.data.description,
					createdAt: now,
					lastUpdated: now,
					examples: args.data.examples,
					library: args.data.library,
				};

				// Validate final library code before saving
				const validation = await validateJavaScriptSyntax(newSkill.library);
				if (!validation.valid) {
					throw new Error(validation.error);
				}

				await skillsRepo.saveSkill(newSkill);

				return {
					content: [{ type: "text", text: `Skill '${args.data.name}' created.` }],
					details: newSkill,
				};
			}

			case "rewrite": {
				if (!args.name) {
					throw new Error("Missing 'name' parameter for rewrite.");
				}
				if (!args.data) {
					throw new Error("Missing 'data' parameter for rewrite.");
				}

				const existing = await skillsRepo.getSkill(args.name);
				if (!existing) {
					throw new Error(`Skill '${args.name}' not found. Use create action.`);
				}

				// Check if name is being changed
				const newName = args.data.name;
				if (newName && newName !== existing.name) {
					const existingWithNewName = await skillsRepo.getSkill(newName);
					if (existingWithNewName) {
						throw new Error(`Rewrite failed: Skill with name '${newName}' already exists.`);
					}
				}

				// Merge with existing (rewrite provided fields)
				const updated: Skill = {
					...existing,
					...args.data,
					name: newName || existing.name, // Allow name change
					createdAt: existing.createdAt, // Keep original creation date
					lastUpdated: new Date().toISOString(),
				};

				// Validate final library code before saving
				const validation = await validateJavaScriptSyntax(updated.library);
				if (!validation.valid) {
					throw new Error(validation.error);
				}

				// If name changed, delete old and save with new name
				if (newName && newName !== existing.name) {
					await skillsRepo.deleteSkill(args.name);
				}
				await skillsRepo.saveSkill(updated);

				return {
					content: [{ type: "text", text: `Skill '${args.name}' rewritten.` }],
					details: updated,
				};
			}

			case "update": {
				if (!args.name) {
					throw new Error("Missing 'name' parameter for update.");
				}
				if (!args.updates) {
					throw new Error("Missing 'updates' parameter for update.");
				}

				const existing = await skillsRepo.getSkill(args.name);
				if (!existing) {
					throw new Error(`Skill '${args.name}' not found. Use create action.`);
				}

				// Apply updates to each field
				const updated: Skill = { ...existing };
				let newName: string | undefined;

				if (args.updates.name) {
					const { old_string, new_string } = args.updates.name;
					if (!updated.name.includes(old_string)) {
						throw new Error("Update failed: old_string not found in name field.");
					}
					newName = updated.name.replace(old_string, new_string);
					// Check if new name already exists
					const existingWithNewName = await skillsRepo.getSkill(newName);
					if (existingWithNewName) {
						throw new Error(`Update failed: Skill with name '${newName}' already exists.`);
					}
					updated.name = newName;
				}

				if (args.updates.shortDescription) {
					const { old_string, new_string } = args.updates.shortDescription;
					if (!updated.shortDescription.includes(old_string)) {
						throw new Error("Update failed: old_string not found in shortDescription field.");
					}
					updated.shortDescription = updated.shortDescription.replace(old_string, new_string);
				}

				if (args.updates.domainPatterns) {
					const { old_string, new_string } = args.updates.domainPatterns;
					updated.domainPatterns = updated.domainPatterns.map((pattern) =>
						pattern.replace(old_string, new_string),
					);
				}

				if (args.updates.library) {
					const { old_string, new_string } = args.updates.library;
					if (!updated.library.includes(old_string)) {
						throw new Error("Update failed: old_string not found in library field.");
					}
					updated.library = updated.library.replace(old_string, new_string);

					// Validate updated library syntax
					const validation = await validateJavaScriptSyntax(updated.library);
					if (!validation.valid) {
						throw new Error(`Update failed: Syntax error in updated library: ${validation.error}`);
					}
				}

				if (args.updates.description) {
					const { old_string, new_string } = args.updates.description;
					if (!updated.description.includes(old_string)) {
						throw new Error("Update failed: old_string not found in description field.");
					}
					updated.description = updated.description.replace(old_string, new_string);
				}

				if (args.updates.examples) {
					const { old_string, new_string } = args.updates.examples;
					if (!updated.examples.includes(old_string)) {
						throw new Error("Update failed: old_string not found in examples field.");
					}
					updated.examples = updated.examples.replace(old_string, new_string);
				}

				updated.lastUpdated = new Date().toISOString();

				// Validate final library code before saving
				const finalValidation = await validateJavaScriptSyntax(updated.library);
				if (!finalValidation.valid) {
					throw new Error(finalValidation.error);
				}

				// If name changed, delete old and save with new name
				if (newName) {
					await skillsRepo.deleteSkill(args.name);
				}
				await skillsRepo.saveSkill(updated);

				return {
					content: [{ type: "text", text: `Skill '${args.name}' updated.` }],
					details: updated,
				};
			}

			case "delete": {
				if (!args.name) {
					throw new Error("Missing 'name' parameter for delete.");
				}

				const existing = await skillsRepo.getSkill(args.name);
				if (!existing) {
					return {
						content: [{ type: "text", text: `Skill '${args.name}' not found.` }],
						details: {},
					};
				}

				await skillsRepo.deleteSkill(args.name);
				return {
					content: [{ type: "text", text: `Skill '${args.name}' deleted.` }],
					details: { name: args.name },
				};
			}

			default:
				throw new Error(`Unknown action: ${(args as any).action}`);
		}
	},
};

// Renderer result types
interface SkillResultDetails {
	skills?: Skill[];
	name?: string;
	domainPatterns?: string[];
	shortDescription?: string;
	description?: string;
	examples?: string;
	library?: string;
}

export const skillRenderer: ToolRenderer<SkillParams, SkillResultDetails> = {
	render(
		params: SkillParams | undefined,
		result: ToolResultMessage<SkillResultDetails> | undefined,
	): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";

		// Helper to render domain pills
		const renderDomainPills = (patterns: string[]) => html`
			<div class="flex flex-wrap gap-2">
				${patterns.map((pattern) => DomainPill(pattern))}
			</div>
		`;

		// Helper to render header text with inline skill pill
		const renderHeaderWithPill = (labelText: string, skillName?: string, skill?: Partial<Skill>): TemplateResult => {
			if (skillName && skill) {
				// Create full Skill object for pill
				const fullSkill: Skill = {
					name: skillName,
					domainPatterns: skill.domainPatterns || [],
					shortDescription: skill.shortDescription || "",
					description: skill.description || "",
					examples: skill.examples || "",
					library: skill.library || "",
					createdAt: skill.createdAt || "",
					lastUpdated: skill.lastUpdated || "",
				};
				return html`<span>${labelText} ${SkillPill(fullSkill, true)}</span>`;
			}
			return html`<span>${labelText}</span>`;
		};

		// Helper to render skill fields (used by create/update/get)
		const renderSkillFields = (skill: Partial<Skill>, showLibrary: boolean) => html`
			${skill.domainPatterns?.length ? renderDomainPills(skill.domainPatterns) : ""}
			${skill.shortDescription ? html`<div class="text-sm text-muted-foreground mt-3">${skill.shortDescription}</div>` : ""}
			${skill.description ? html`<div class="mt-3"><markdown-block .content=${skill.description}></markdown-block></div>` : ""}
			${
				skill.examples
					? html`
				<div class="mt-3">
					<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Examples")}</div>
					<code-block .code=${skill.examples} language="javascript"></code-block>
				</div>
			`
					: ""
			}
			${
				showLibrary && skill.library
					? html`
				<div class="mt-3">
					<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Library")}</div>
					<code-block .code=${skill.library} language="javascript"></code-block>
				</div>
			`
					: ""
			}
		`;

		// Error handling
		if (result?.isError) {
			const action = params?.action;
			const skillName = params?.name || params?.data?.name;
			const labels: Record<string, string> = {
				get: i18n("Getting skill"),
				list: i18n("Listing skills"),
				create: i18n("Creating skill"),
				rewrite: i18n("Rewriting skill"),
				update: i18n("Updating skill"),
				delete: i18n("Deleting skill"),
			};
			const headerText = skillName ? `${labels[action!] || action} ${skillName}` : labels[action!] || action || "";

			// For create/rewrite errors, show partial skill data with error at bottom - COLLAPSED BY DEFAULT
			if ((action === "create" || action === "rewrite") && params?.data) {
				const contentRef = createRef<HTMLElement>();
				const chevronRef = createRef<HTMLElement>();
				const skillName = params?.data?.name;

				return {
					content: html`
					<div>
						${renderCollapsibleHeader(state, Sparkles, skillName ? renderHeaderWithPill(headerText, skillName, params.data) : headerText, contentRef, chevronRef, false)}
						<div ${ref(contentRef)} class="overflow-hidden transition-all duration-200 ease-in-out max-h-0 space-y-3">
							${renderSkillFields(params.data, true)}
							<div class="w-full px-3 py-2 text-sm text-destructive bg-destructive/10 border border-destructive rounded">
								${result.content.find((c) => c.type === "text")?.text || ""}
							</div>
						</div>
					</div>
				`,
					isCustom: false,
				};
			}

			return {
				content: html`
				<div class="space-y-3">
					${renderHeader(state, Sparkles, headerText)}
					<div class="text-sm text-destructive">${result.content.find((c) => c.type === "text")?.text || ""}</div>
				</div>
			`,
				isCustom: false,
			};
		}

		// Full params + result
		if (result && params) {
			const { action } = params;
			const skill = result.details;

			switch (action) {
				case "get": {
					// Show clickable skill pill in header
					if (!skill?.name) {
						return {
							content: renderHeader(state, Sparkles, i18n("No skills found")),
							isCustom: false,
						};
					}

					// Create a full Skill object from the result details
					const fullSkill: Skill = {
						name: skill.name,
						domainPatterns: skill.domainPatterns || [],
						shortDescription: skill.shortDescription || "",
						description: skill.description || "",
						examples: skill.examples || "",
						library: skill.library || "",
						createdAt: "",
						lastUpdated: "",
					};

					const statusIcon = html`<span class="inline-block text-green-600 dark:text-green-500">${icon(Sparkles, "sm")}</span>`;

					return {
						content: html`
						<div class="flex items-center gap-2 text-sm text-muted-foreground">
							${statusIcon}
							<span>${i18n("Got skill")}</span>
							${SkillPill(fullSkill, true)}
						</div>
					`,
						isCustom: false,
					};
				}

				case "list": {
					// Show "Skills for <domain>" header + skill pills
					const skills = skill?.skills || [];
					if (skills.length === 0) {
						return {
							content: renderHeader(state, Sparkles, i18n("No skills found")),
							isCustom: false,
						};
					}

					// Get domain from first skill
					const domain = skills[0]?.domainPatterns?.[0] || "";
					const statusIcon = html`<span class="inline-block text-green-600 dark:text-green-500">${icon(Sparkles, "sm")}</span>`;

					return {
						content: html`
						<div class="space-y-3">
							<div class="flex items-center gap-2 text-sm text-muted-foreground">
								${statusIcon}
								<span>${i18n("Skills for domain")}</span>
								${domain ? DomainPill(domain) : ""}
							</div>
							<div class="flex flex-wrap gap-2">
								${skills.map((s) => SkillPill(s, true))}
							</div>
						</div>
					`,
						isCustom: false,
					};
				}

				case "create":
				case "rewrite": {
					// Show all skill fields (including library) - COLLAPSED BY DEFAULT
					// Skill data comes from result.details (full Skill object)
					const skillData = skill || params.data || {};
					const skillName = skillData.name;
					if (!skillName) {
						return {
							content: renderHeader(state, Sparkles, i18n("Processing skill...")),
							isCustom: false,
						};
					}

					const labelText =
						action === "create"
							? state === "complete"
								? i18n("Created skill")
								: i18n("Creating skill")
							: state === "complete"
								? i18n("Rewritten skill")
								: i18n("Rewriting skill");

					const contentRef = createRef<HTMLElement>();
					const chevronRef = createRef<HTMLElement>();

					return {
						content: html`
						<div>
							${renderCollapsibleHeader(state, Sparkles, renderHeaderWithPill(labelText, skillName, skillData), contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="overflow-hidden transition-all duration-200 ease-in-out max-h-0">
								${renderSkillFields(skillData, true)}
							</div>
						</div>
					`,
						isCustom: false,
					};
				}

				case "update": {
					// Show diffs for updated fields
					const skillName = params.name;
					if (!skillName) {
						return {
							content: renderHeader(state, Sparkles, i18n("Processing skill...")),
							isCustom: false,
						};
					}

					const labelText = state === "complete" ? i18n("Updated skill") : i18n("Updating skill");
					const contentRef = createRef<HTMLElement>();
					const chevronRef = createRef<HTMLElement>();

					const updates = params.updates || {};
					// Use the full skill from result.details if available, otherwise just the name
					const skillData = skill || { name: skillName };

					return {
						content: html`
						<div>
							${renderCollapsibleHeader(state, Sparkles, renderHeaderWithPill(labelText, skillName, skillData), contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="overflow-hidden transition-all duration-200 ease-in-out max-h-0 space-y-3">
								${
									updates.library
										? html`
									<div>
										<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Library")}</div>
										${Diff({ oldText: updates.library.old_string, newText: updates.library.new_string })}
									</div>
								`
										: ""
								}
								${
									updates.description
										? html`
									<div>
										<div class="text-sm font-medium text-muted-foreground mb-2">Description</div>
										${Diff({ oldText: updates.description.old_string, newText: updates.description.new_string })}
									</div>
								`
										: ""
								}
								${
									updates.examples
										? html`
									<div>
										<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Examples")}</div>
										${Diff({ oldText: updates.examples.old_string, newText: updates.examples.new_string })}
									</div>
								`
										: ""
								}
							</div>
						</div>
					`,
						isCustom: false,
					};
				}

				case "delete": {
					// Show "Deleted skill" with pill in header row
					const skillName = params.name;
					const statusIcon = html`<span class="inline-block text-green-600 dark:text-green-500">${icon(Sparkles, "sm")}</span>`;
					return {
						content: html`
						<div class="flex items-center gap-2 text-sm text-muted-foreground">
							${statusIcon}
							<span>${i18n("Deleted skill")}</span>
							${skillName ? SkillPill(skillName) : ""}
						</div>
					`,
						isCustom: false,
					};
				}

				default:
					return {
						content: renderHeader(state, Sparkles, result.content.find((c) => c.type === "text")?.text || ""),
						isCustom: false,
					};
			}
		}

		// Params only (streaming)
		if (params) {
			const { action, name, data } = params;

			switch (action) {
				case "create":
				case "rewrite": {
					// Show streaming skill fields as they come in
					const skillName = data?.name || name;
					if (!skillName) {
						const labels: Record<string, string> = {
							create: i18n("Creating skill"),
							rewrite: i18n("Rewriting skill"),
						};
						return {
							content: renderHeader(state, Sparkles, labels[action] || ""),
							isCustom: false,
						};
					}

					const labels: Record<string, string> = {
						create: i18n("Creating skill"),
						rewrite: i18n("Rewriting skill"),
					};
					const labelText = labels[action];

					const contentRef = createRef<HTMLElement>();
					const chevronRef = createRef<HTMLElement>();

					return {
						content: html`
						<div>
							${renderCollapsibleHeader(state, Sparkles, renderHeaderWithPill(labelText, skillName, data), contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="overflow-hidden transition-all duration-200 ease-in-out max-h-0">
								${data ? renderSkillFields(data, true) : ""}
							</div>
						</div>
					`,
						isCustom: false,
					};
				}
				case "update": {
					// Show streaming diffs as they come in
					const skillName = name;
					if (!skillName) {
						return {
							content: renderHeader(state, Sparkles, i18n("Updating skill")),
							isCustom: false,
						};
					}

					const labelText = i18n("Updating skill");
					const contentRef = createRef<HTMLElement>();
					const chevronRef = createRef<HTMLElement>();
					const updates = params.updates || {};
					const skillData = { name: skillName };

					return {
						content: html`
						<div>
							${renderCollapsibleHeader(state, Sparkles, renderHeaderWithPill(labelText, skillName, skillData), contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="overflow-hidden transition-all duration-200 ease-in-out max-h-0 space-y-3">
								${
									updates.library
										? html`
									<div>
										<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Library")}</div>
										${Diff({ oldText: updates.library.old_string, newText: updates.library.new_string })}
									</div>
								`
										: ""
								}
								${
									updates.description
										? html`
									<div>
										<div class="text-sm font-medium text-muted-foreground mb-2">Description</div>
										${Diff({ oldText: updates.description.old_string, newText: updates.description.new_string })}
									</div>
								`
										: ""
								}
								${
									updates.examples
										? html`
									<div>
										<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Examples")}</div>
										${Diff({ oldText: updates.examples.old_string, newText: updates.examples.new_string })}
									</div>
								`
										: ""
								}
							</div>
						</div>
					`,
						isCustom: false,
					};
				}
				default: {
					const skillName = name || data?.name;
					const labels: Record<string, string> = {
						get: i18n("Getting skill"),
						list: i18n("Listing skills"),
						delete: i18n("Deleting skill"),
					};
					const headerText = skillName
						? `${labels[action] || action} ${skillName}`
						: labels[action] || action || "";
					return {
						content: renderHeader(state, Sparkles, headerText),
						isCustom: false,
					};
				}
			}
		}

		// No params, no result
		return {
			content: renderHeader(state, Sparkles, i18n("Processing skill...")),
			isCustom: false,
		};
	},
};

registerToolRenderer(skillTool.name, skillRenderer);
