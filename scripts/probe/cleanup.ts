// Close every tab of the given bridge sessions (test clutter): tsx cleanup.ts <sessionKey>...
import { BridgeClient } from "../../cli/src/client.ts";

for (const session of process.argv.slice(2)) {
	const client = new BridgeClient({ name: session.split("|")[0], session: session.split("|")[1] });
	await client.connect();
	const ctx = (await client.call("tabs.context", {}, 30000)) as { tabs: Array<{ tabId: number }> };
	for (const t of ctx.tabs) await client.call("tabs.close", { tabId: t.tabId }, 30000);
	console.log(session, "closed", ctx.tabs.length);
	client.close();
}
