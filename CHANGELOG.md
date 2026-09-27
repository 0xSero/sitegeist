# Changelog

## [Unreleased]

### Added
- `actions` bridge method and MCP tool: up to 40 input steps (press, click, drag, type, hover, scroll, wait) in one call with an optional closing screenshot. A canvas flowchart (two shapes, labels, bound arrow) is one call instead of 60 to 120 model turns.
- `sitegeist debug` lists the active tab per window and records foreground-guard decisions; `bridge.activate` puts a tab back in front (dev aid after a focus mishap).
- `tabs.context` flags tabs that sit outside the session's group (`inGroup: false`).
- `scripts/bench/`: omp-driven workflow benchmark (drawing in Excalidraw/tldraw sandboxes, multi-tab research, form round trips) with trace stats, post-run inspection (tabs, group membership, app-state verification) and a per-task focus-steal check; `scripts/probe/` for raw bridge calls.
- Browser sessions: every chat owns its own tab group and works in the background. Tabs open inactive, tools act on the session's current tab, and the agent never sees the user's other tabs. The tab the side panel is opened on becomes the session's first tab (the group appears immediately); a "share this tab" button hands over further tabs; `navigate { showTab }` is the only way the agent brings a tab forward.
- Screenshots and trusted input events go through `chrome.debugger` (works on hidden tabs; focus emulation keeps requestAnimationFrame and lazy loading alive off-screen).
- Foreground guard: popups opened by agent tabs no longer steal focus.
- Dynamic model discovery: provider model lists are fetched at runtime (Anthropic, OpenAI, ChatGPT/Codex, Gemini, GitHub Copilot, OpenRouter, Mistral, Groq, xAI, Cerebras, Hugging Face), enriched from the generated table and models.dev, cached in IndexedDB.
- Bridge for external agents: `cli/` ships the `sitegeist` command (`sitegeist mcp`, `install`, `status`, `allow`, `reload`, `debug`, `pi-extension`). Harnesses reach the browser through a native messaging host and a user-only unix socket; each harness gets its own tab group. Settings > Bridge controls site permissions.

### Changed
- `navigate` gained `showTab` and `closeTab`; `switchToTab` no longer focuses the tab.
- Composer: ArrowUp in an empty composer recalls the last prompt; the model picker is a plain model-id button and the send button is an arrow (pi-web-ui `MessageEditor`/`AgentInterface`, see README). The provider/auth label was removed from the header.
- Browser sessions persist in `chrome.storage.local` (they and their groups survive extension reloads), grouping retries when Chromium refuses a tab edit, and the panel adopts the tab it opens on even when that is a New Tab page.
- Side panel is bound to a tab, not a window (Claude-in-Chrome model): each task lives on the tab its panel was opened on via `sidepanel.html?tabId=<tab>`, and the manifest declares no default panel, so a tab shows the panel only when a task owns it. Two tasks = two tabs, each with its own panel; put them in two windows to see both at once. The window-session lock and the "locked" landing page are gone; `src/utils/port.ts` is now lifecycle-only. While a task is mid-run its panel stays on the window's active tab so switching tabs doesn't tear the agent down.
- Removed upstream working notes from the repository root (`db.md`, `gmail.md`, `plan.md`).

### Fixed
- Hidden agent tabs render at a fixed 1280x800 viewport (CDP device-metrics override, dropped while the user looks at the tab and restored when the agent acts on it again), so screenshot pixels, DOM coordinates and click coordinates are the same numbers in every window; models mixed the two scales on wide windows and clicked the wrong spots.
- `actions` spaces steps by `settleMs` (default 80 ms) so a keystroke after Enter is not lost while the app opens its text editor, and accepts `key`, `text`, `doubleClick`, `move`, `sleep` and mid-list `screenshot` steps.
- Screenshot coordinates: x/y for click, drag, hover and scroll are pixels of the tab's latest screenshot and are mapped to the page in the extension (models no longer multiply by a scale factor, which they got wrong); default screenshots are CSS-pixel scale up to 1280 px wide (the DPR was double-counted before).
- `drag` reports the held button on moves (`buttons: 1`) and moves in 12 steps, so pointer-driven canvas apps register the drag.
- Popups from `target=_blank` links (noopener, no `openerTabId`) are adopted via `webNavigation.onCreatedNavigationTarget`; the guard restores the tab the user was on right before the popup, and tabs Chrome drops into an agent's group become that agent's.
- `navigate` reports `loading: true` only when the wait timed out, not whenever subresources are still loading (models spent a turn waiting after every navigation).
- Screenshots of background tabs took 30 to 75 s and could stall the bridge: captures are now scaled inside the renderer (`clip.scale`) as JPEG with `optimizeForSpeed`, and bounded at 20 s with an actionable error. Bridge screenshots default to 1024 px JPEG.
- Empty tabs: tools no longer open an `about:blank` tab when a session has none (they tell the model to navigate first); the first `navigate` opens the tab straight on its URL, and `newTab` / `tabs.create` no longer load the URL twice. Abandoned bridge sessions have their blank tabs closed.
- Tab groups: a new session could take over another agent's group whose title matched (all `mcp` clients shared one group); groups now belong to one session, labels are made unique (`omp`, `omp 2`), stray tabs are regrouped, tabs in another window are moved to the group's window, and a group that refuses a tab is replaced instead of leaving the tab loose. A tab belongs to exactly one session.
- Disconnections: `sitegeist mcp` always uses a stable session key, so reconnects keep their tabs, and the CLI client retries a call once after an extension reload, service-worker restart or host respawn (waiting up to 40 s for the bridge to come back).
- Stale sessions: the session table (130+ dead records here) is pruned on worker start and every 5 minutes; idle abandoned agent groups are collapsed.
- Navigation: waits start at commit (a load still finishing from the previous page no longer satisfies them), hash and pushState navigations return immediately instead of waiting out the timeout, network errors are reported (`net::ERR_NAME_NOT_RESOLVED`), and results say `loading: true` when the page is still loading. Prerendered pages that swap tab ids keep their session.
- Side panel: clicking the toolbar icon on a tab that already shows a panel (including a running task's panel kept up on another tab) opens it instead of re-pointing it, which reloaded the panel and killed the running agent; opening the panel on a tab an external agent is driving no longer steals that tab; the busy state names the running task, so the right panel is kept up; re-opening a session no longer yanks the agent back to its home tab.
- Foreground guard: a link the user opens from a tab they are looking at is no longer pulled back out of view.
- Custom OpenAI-compatible providers (Local Studio, vLLM, SGLang) no longer send `max_tokens` (the dialog default of 8192 cut thinking models off mid-answer); discovery reads `max_model_len` as the context window. Requires pi-ai's new `compat.omitMaxTokens`.
- MCP token use: `read_page` and `find` return one line per element instead of pretty JSON (roughly a quarter of the tokens), `read_page` text defaults to 3000 characters, snapshots list in-viewport elements first so long pages are not cut above the fold, and tool descriptions spell out the tab-group workflow.
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
