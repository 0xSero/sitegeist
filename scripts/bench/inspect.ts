// Post-run inspection of one benchmark session, then cleanup.
// usage: tsx inspect.ts <sessionKey> <outdir> <taskId> [verifyJs] [--keep]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BridgeClient } from "../../cli/src/client.ts";

const [session, out, id, verifyJs] = process.argv.slice(2);
const keep = process.argv.includes("--keep");
const client = new BridgeClient({ name: "omp", session });
await client.connect();
const result: Record<string, unknown> = {};
const ctx = (await client.call("tabs.context", {}, 30000)) as {
	tabs: Array<{ tabId: number; url: string; inGroup?: boolean }>;
};
result.tabs = ctx.tabs;
result.tabCount = ctx.tabs.length;
result.blankTabs = ctx.tabs.filter((t) => !t.url || t.url === "about:blank").length;
result.ungrouped = ctx.tabs.filter((t) => t.inGroup === false).length;
if (ctx.tabs.length > 0) {
	if (verifyJs) {
		try {
			result.verify = (
				(await client.call("evaluate", { code: verifyJs, world: "main" }, 30000)) as { value: unknown }
			).value;
		} catch (e) {
			result.verifyError = String(e);
		}
	}
	try {
		const shot = (await client.call("screenshot", {}, 40000)) as { data: string };
		writeFileSync(join(out, `${id}.final.jpg`), Buffer.from(shot.data, "base64"));
	} catch (e) {
		result.screenshotError = String(e);
	}
	if (!keep)
		for (const t of ctx.tabs) await client.call("tabs.close", { tabId: t.tabId }, 30000).catch(() => undefined);
}
writeFileSync(join(out, `${id}.inspect.json`), JSON.stringify(result, null, 1));
console.log(
	JSON.stringify({
		id,
		tabCount: result.tabCount,
		blank: result.blankTabs,
		ungrouped: result.ungrouped,
		verify: typeof result.verify === "string" ? (result.verify as string).slice(0, 200) : result.verify,
	}),
);
client.close();
