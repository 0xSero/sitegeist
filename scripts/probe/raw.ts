// Maintenance call without a session: tsx scripts/probe/raw.ts <method> '<json>'
import { BridgeClient } from "../../cli/src/client.ts";

const client = new BridgeClient({ name: "maint" });
await client.connect();
console.log(JSON.stringify(await client.call(process.argv[2], JSON.parse(process.argv[3] ?? "{}"), 10000)));
client.close();
