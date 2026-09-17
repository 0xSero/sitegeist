# Changelog

## [Unreleased]

### Added
- Browser sessions: every chat owns its own tab group and works in the background. Tabs open inactive, tools act on the session's current tab, and the agent never sees the user's other tabs. The tab the side panel is opened on becomes the session's first tab (the group appears immediately); a "share this tab" button hands over further tabs; `navigate { showTab }` is the only way the agent brings a tab forward.
- Screenshots and trusted input events go through `chrome.debugger` (works on hidden tabs; focus emulation keeps requestAnimationFrame and lazy loading alive off-screen).
- Foreground guard: popups opened by agent tabs no longer steal focus.
- Dynamic model discovery: provider model lists are fetched at runtime (Anthropic, OpenAI, ChatGPT/Codex, Gemini, GitHub Copilot, OpenRouter, Mistral, Groq, xAI, Cerebras, Hugging Face), enriched from the generated table and models.dev, cached in IndexedDB.
- Bridge for external agents: `cli/` ships the `sitegeist` command (`sitegeist mcp`, `install`, `status`, `allow`, `reload`, `debug`, `pi-extension`). Harnesses reach the browser through a native messaging host and a user-only unix socket; each harness gets its own tab group. Settings > Bridge controls site permissions.

### Changed
- `navigate` gained `showTab` and `closeTab`; `switchToTab` no longer focuses the tab.
- Removed upstream working notes from the repository root (`db.md`, `gmail.md`, `plan.md`).

### Fixed
- The side panel no longer requires the "Allow User Scripts" toggle: page injection (`browserjs()`, overlay, element picker, image extraction) runs through `userScripts` when available and through the debugger's `Runtime.evaluate` otherwise, with a CDP-binding shim standing in for `chrome.runtime.sendMessage` (`src/browser/inject.ts`). `userScripts` moved to `optional_permissions`.
- Type errors in `CustomProviderEditDialog` (missing i18n keys) and `CustomProvidersTab` (`remove` shadowed `HTMLElement.remove`).
- Manifest: fixed extension `key` (stable id `bbkgpflnkggdfabgjhofdmdopgjopamc`), new permissions `tabGroups`, `nativeMessaging`, `alarms`.

## [1.0.0] - 2026-03-15

### Added

- Browser-based OAuth login for Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro), GitHub Copilot, and Google Gemini CLI
- Combined "API Keys & OAuth" settings tab with subscription login and API key entry
- Welcome setup dialog on first launch when no providers are configured
- Auto-select default model for the first provider with a key
- Provider and auth type indicator in the header bar
- Image extraction tool (`extract_image`) with selector and screenshot modes
- Subsequence-based fuzzy search in the model selector
- CORS proxy warning in OAuth sections (orange when enabled, red when disabled)
- GitHub Actions workflow for tagged releases
- `release.sh` script for version bumping and tagged releases

### Changed

- Default model changed to `claude-sonnet-4-6` with `medium` thinking level
- CORS proxy enabled by default
- Model selector only shows models from providers with configured keys
- API key prompt dialog now shows both OAuth login and API key entry for supported providers
- Tool execution set to sequential mode (parallel caused rendering issues in sidebar)
- Site converted to static (removed backend, admin, waitlist signups)
- Download links point to GitHub Releases
- License changed from MIT to AGPL-3.0

### Fixed

- Settings dialog tabs not responding to clicks (upstream `pi-web-ui` built with `tsgo` broke Lit decorator reactivity)
- CORS proxy toggle not updating (same root cause)
- Proxy not applied to API requests (esbuild bundled duplicate `streamSimple` references, breaking identity check)
- Model selector button not updating after picking a model (added `state_change` event to Agent)
- Duplicate tool component rendering during streaming (cleared streaming container on `message_end`)
- Screenshot tool capturing sidepanel instead of the webpage
