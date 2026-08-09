import { createHmac, timingSafeEqual } from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 64 * 1024;
export interface Envelope { version: 1; jobId: string; seq: number; replyTo?: number; type: string; payload?: unknown; auth: string; }

function canonical(frame: Omit<Envelope, "auth">): string { return JSON.stringify(frame); }
export class AuthenticatedProtocol {
  private inbound = 0;
  private seen = new Set<number>();
  readonly jobId: string; private readonly token: string; readonly maxBytes: number;
  constructor(jobId: string, token: string, maxBytes = MAX_FRAME_BYTES) { this.jobId=jobId; this.token=token; this.maxBytes=maxBytes; }
  encode(type: string, seq: number, payload?: unknown, replyTo?: number): string {
    const unsigned: Omit<Envelope, "auth"> = { version: PROTOCOL_VERSION, jobId: this.jobId, seq, type, ...(payload === undefined ? {} : { payload }), ...(replyTo === undefined ? {} : { replyTo }) };
    const auth = createHmac("sha256", this.token).update(canonical(unsigned)).digest("hex");
    const encoded = JSON.stringify({ ...unsigned, auth });
    if (Buffer.byteLength(encoded) > this.maxBytes) throw new Error("control frame exceeds size limit");
    return `${encoded}\n`;
  }
  decode(line: string): Envelope | undefined {
    if (Buffer.byteLength(line) > this.maxBytes) throw new Error("control frame exceeds size limit");
    let value: any; try { value = JSON.parse(line); } catch { throw new Error("malformed control frame"); }
    if (value.version !== PROTOCOL_VERSION || value.jobId !== this.jobId || !Number.isSafeInteger(value.seq) || value.seq < 1 || typeof value.type !== "string" || typeof value.auth !== "string") throw new Error("invalid control frame");
    const { auth, ...unsigned } = value;
    const expected = createHmac("sha256", this.token).update(canonical(unsigned)).digest();
    let supplied: Buffer; try { supplied = Buffer.from(auth, "hex"); } catch { throw new Error("invalid authentication"); }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("invalid authentication");
    if (this.seen.has(value.seq)) return undefined;
    if (value.seq <= this.inbound) throw new Error("out-of-order control frame");
    this.inbound = value.seq; this.seen.add(value.seq);
    if (this.seen.size > 2048) this.seen.delete(Math.min(...this.seen));
    return value as Envelope;
  }
}
