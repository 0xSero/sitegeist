#!/usr/bin/env python3
"""Run a sitegeist benchmark task set through omp.

usage: run.py <model> <outdir> [--tasks FILE] [--par N] [task ids...]
Each task runs `omp -p` with its own SITEGEIST_SESSION (its own tab group). Afterwards
inspect.ts records the session's tabs (count, blank, outside the group), runs the task's
verify_js in the agent's tab, saves a final screenshot and closes the tabs. The user's
active tab per window is captured before and after (focus-steal check).
"""
import argparse, json, os, subprocess, time
from concurrent.futures import ThreadPoolExecutor

ap = argparse.ArgumentParser()
ap.add_argument("model"); ap.add_argument("out"); ap.add_argument("ids", nargs="*")
ap.add_argument("--tasks", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks.json"))
ap.add_argument("--par", type=int, default=3)
a = ap.parse_args()
here = os.path.dirname(os.path.abspath(__file__))
repo = os.path.dirname(os.path.dirname(here))
tasks = [t for t in json.load(open(a.tasks)) if not a.ids or t["id"] in a.ids]
os.makedirs(a.out, exist_ok=True)
SYS = ("You have sitegeist browser tools (MCP server sitegeist) that drive a real Chromium browser in the background. "
       "Use ONLY those browser tools for web access: no bash, curl, fetch, or web search. Finish with a concise final answer.")
stamp = str(int(time.time()))

def windows():
    try:
        d = json.loads(subprocess.run(["sitegeist", "debug"], capture_output=True, text=True, timeout=30).stdout)
        return {str(w["windowId"]): [w.get("activeTabId"), w.get("activeUrl")] for w in d.get("windows", [])}
    except Exception as e:
        return {"error": str(e)}



def trace_stats(jsonl):
    """Tool calls per sitegeist tool, tool errors, turns, tokens, final answer from an omp json trace."""
    calls, errors, turns, tokens, final = {}, [], 0, 0, ""
    for line in jsonl.splitlines():
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") == "tool_execution_start":
            args = e.get("args") or {}
            name = str(args.get("path", e.get("toolName"))).replace("xd://mcp__sitegeist_", "")
            calls[name] = calls.get(name, 0) + 1
        elif e.get("type") == "tool_execution_end" and (e.get("isError") or (e.get("result") or {}).get("isError")):
            txt = json.dumps(e.get("result"))[:200]
            errors.append(txt)
        elif e.get("type") == "turn_end":
            turns += 1
            u = (e.get("message") or {}).get("usage") or {}
            tokens += u.get("totalTokens", 0)
        elif e.get("type") == "agent_end":
            for m in reversed(e.get("messages", [])):
                if m.get("role") == "assistant":
                    final = "".join(c.get("text", "") for c in m.get("content", []) if c.get("type") == "text")
                    if final:
                        break
    return {"calls": calls, "ncalls": sum(calls.values()), "errors": errors, "turns": turns, "tokens": tokens, "final": final}

def run(t):
    key = f"bench-{t['id']}-{stamp}"
    env = dict(os.environ, SITEGEIST_CLIENT_NAME="omp", SITEGEIST_SESSION=key, SITEGEIST_AUTO_ALLOW="1")
    cmd = ["omp", "-p", "--mode", "json", "--model", a.model, "--no-session", "--approval-mode", "yolo", "--max-time", "20m",
           "--append-system-prompt", SYS, t["prompt"]]
    start = time.time()
    trace_path = os.path.join(a.out, t["id"] + ".jsonl")
    # Stream straight to disk: a timeout must not lose the partial trace.
    with open(trace_path, "w") as so_f, open(os.path.join(a.out, t["id"] + ".err"), "w") as se_f:
        p = subprocess.Popen(cmd, env=env, cwd="/private/tmp", stdout=so_f, stderr=se_f)
        try:
            code = p.wait(timeout=1300)
        except subprocess.TimeoutExpired:
            p.kill()
            code = "timeout"
    secs = round(time.time() - start)
    shown = windows()  # before inspect closes the tabs
    so = open(trace_path).read()
    stats = trace_stats(so)
    open(os.path.join(a.out, t["id"] + ".out"), "w").write(stats.pop("final", ""))
    insp = subprocess.run(["npx", "tsx", "scripts/bench/inspect.ts", key, a.out, t["id"], t.get("verify_js", "")],
                          cwd=repo, capture_output=True, text=True, timeout=180)
    mine = set()
    try:
        mine = {tab["tabId"] for tab in json.load(open(os.path.join(a.out, t["id"] + ".inspect.json"))).get("tabs", [])}
    except Exception:
        pass
    stats["focus_stolen"] = [w for w, v in shown.items() if isinstance(v, list) and v[0] in mine]
    line = f"{t['id']} exit={code} secs={secs} stats={json.dumps(stats)} inspect={insp.stdout.strip()[:300]}"
    print(line, flush=True)
    return line

before = windows()
with ThreadPoolExecutor(a.par) as ex:
    lines = list(ex.map(run, tasks))
after = windows()
lines.append(f"windows before={json.dumps(before)} after={json.dumps(after)}")
open(os.path.join(a.out, "summary.txt"), "w").write("\n".join(lines) + "\n")
print(lines[-1])
