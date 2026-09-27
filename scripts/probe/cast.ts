import { BridgeClient } from "../../cli/src/client.ts";

const t0 = performance.now();
let n = 0;
const client = new BridgeClient({
	name: "probe",
	session: process.argv[2],
	onEvent: (e, d) => {
		if (e === "screencast_frame") {
			n++;
			if (n <= 3) console.log("frame", n, Math.round(performance.now() - t0), "ms", String(d.data).length);
		} else console.log("event", e);
	},
});
await client.connect();
console.log(
	JSON.stringify(await client.call("screencast.start", { maxWidth: 800, maxFps: 5 })),
	Math.round(performance.now() - t0),
);
await new Promise((r) => setTimeout(r, 8000));
console.log(JSON.stringify(await client.call("screencast.stop", {})), "frames", n);
client.close();
