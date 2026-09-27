// Ad-hoc bridge probe: tsx scripts/probe/call.ts <session> <method> '<json params>' [...more method/json pairs]
import { BridgeClient } from "../../cli/src/client.ts";

const [session, ...rest] = process.argv.slice(2);
const client = new BridgeClient({
	name: "probe",
	session,
	onEvent: (e, d) => console.error("event", e, JSON.stringify(d).slice(0, 200)),
});
await client.connect();
for (let i = 0; i < rest.length; i += 2) {
	const t = performance.now();
	try {
		const r = await client.call(rest[i], JSON.parse(rest[i + 1] ?? "{}"), 120000);
		const s = JSON.stringify(r);
		console.log(`${rest[i]} ${Math.round(performance.now() - t)}ms ${s.length > 600 ? `${s.slice(0, 600)}...` : s}`);
	} catch (e) {
		console.log(`${rest[i]} ${Math.round(performance.now() - t)}ms ERROR ${e instanceof Error ? e.message : e}`);
	}
}
client.close();
