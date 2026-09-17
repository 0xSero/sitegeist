# Bridge benchmarks, 2026-09-16

Four real tasks run through the bridge by an external harness, with ground truth
fetched independently (Hacker News API and front page HTML, Wikipedia wikitext, the
httpbin echo, the GitHub API). Frames of the agent's hidden tab were captured every
1.5 s through the same bridge while the task ran; the demo video is assembled from them.

Harness: Claude Code (`claude -p`) with `--mcp-config` pointing at `sitegeist mcp`,
hosts pre-allowed with `sitegeist allow <host>`. Browser: Brave 152 on macOS, 25 to 34
user tabs open, the user working in other Spaces the whole time.

| Task | Result | Wall time | Tool calls | Verdict |
| --- | --- | --- | --- | --- |
| Hacker News: top 5 titles with points | 5 stories | 28.1 s | 5 | Correct. Titles and order matched the live front page; points matched at read time (top story moved by 4 before the check). |
| Wikipedia: Copenhagen municipality population from the infobox | 671,714 as of 1 January 2026 | 27.7 s | 5 | Correct (matches page wikitext). |
| httpbin form: fill 7 fields, submit, read the echoed JSON | all fields echoed | 40.6 s | 14 | Correct, including the three fields not asked about. |
| GitHub: repository description and star count | description + 825 stars | 31.9 s | 7 | Correct (matches the API). |

Accuracy: 4 of 4. Nothing was brought to the foreground; each task ran in its own
"Sitegeist · claude" tab group and closed nothing the user owned.

## Bridge latency during the runs

From `sitegeist debug` (per-call timing inside the extension, excluding model time):

| Method | Calls | Median | Max |
| --- | --- | --- | --- |
| tabs.context | 77 | 2 ms | 38 ms |
| screenshot (1280 px JPEG, hidden tab) | 44 | 376 ms | 988 ms |
| navigate (incl. page load wait) | 4 | 592 ms | 1414 ms |
| snapshot / text / find / fill / click | 15 | 7 to 16 ms | 16 ms |

Chrome API benchmark with the machine idle (`bridge.bench`): storage, windows, tab group
and debugger target queries all 0 to 6 ms; session open 3 ms.

Model time dominates: each task's 28 to 41 s is almost entirely Claude thinking and
tool-round-trips; the browser side contributes well under two seconds per task.

## What went wrong before this run

- Under heavy machine load (15-minute load average above 150, two local omp agents at
  100% CPU, a screen recording in progress) the same Chrome API calls took 10 to 60 s
  each and one navigation took four minutes. That is the browser being starved, not the
  bridge; the fix was to add per-call timeouts so a slow browser cannot wedge a client.
- The first live run deadlocked: permission answers were queued behind the request that
  was waiting for them. Fixed by handling answers outside the per-client queue.
- pi runs failed for reasons unrelated to the bridge: the local homelab model was
  saturated (no reply in 20 s) and the ChatGPT subscription hit its usage limit
  (`Codex error: The usage limit has been reached`). The pi extension itself connected,
  registered its tools and made calls (`browser_navigate`, `browser_read_page`,
  `browser_fill` ...), so the pi path is exercised; the tasks were completed on Claude
  Code instead.
- Two clients on one session (the agent and the frame recorder) overwrote each other's
  tab list until session instances were shared per id.

## Reproducing

```bash
sitegeist status
sitegeist allow news.ycombinator.com
SITEGEIST_SESSION=demo claude -p "Open https://news.ycombinator.com and list the top 5 stories with points" \
  --mcp-config '{"mcpServers":{"sitegeist":{"command":"sitegeist","args":["mcp"]}}}' \
  --allowedTools "mcp__sitegeist__*"
sitegeist debug     # timings for what just happened
```
