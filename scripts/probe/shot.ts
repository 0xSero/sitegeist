import { writeFileSync } from "node:fs";
import { BridgeClient } from "../../cli/src/client.ts";

const [session, out, params] = process.argv.slice(2);
const client = new BridgeClient({ name: "probe", session });
await client.connect();
const t = performance.now();
const r = (await client.call("screenshot", JSON.parse(params ?? "{}"))) as {
	data: string;
	width: number;
	height: number;
	mimeType: string;
};
writeFileSync(out, Buffer.from(r.data, "base64"));
console.log(r.width, r.height, r.mimeType, Math.round(performance.now() - t), "ms", r.data.length, "b64 chars");
client.close();
