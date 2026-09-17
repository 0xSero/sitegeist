/**
 * `[uint32 LE length][UTF-8 JSON]` framing, the same on stdio (native messaging)
 * and on the unix socket. One parser instance per stream.
 */

export class FrameParser {
	private buffer: Buffer = Buffer.alloc(0);

	constructor(private readonly maxFrame: number) {}

	/** Feed bytes; returns every complete JSON message now available. */
	push(chunk: Buffer): unknown[] {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		const out: unknown[] = [];
		while (this.buffer.length >= 4) {
			const length = this.buffer.readUInt32LE(0);
			if (length > this.maxFrame) throw new Error(`Frame of ${length} bytes exceeds limit ${this.maxFrame}`);
			if (this.buffer.length < 4 + length) break;
			const body = this.buffer.subarray(4, 4 + length).toString("utf8");
			this.buffer = this.buffer.subarray(4 + length);
			out.push(JSON.parse(body));
		}
		return out;
	}
}

export function encodeFrame(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(body.length, 0);
	return Buffer.concat([header, body]);
}
