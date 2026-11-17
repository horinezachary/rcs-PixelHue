// A streaming reader for the switcher's HTTP-FLV preview: H.264 video tags only (a Q8 sends no audio and no
// metadata tag). Push bytes in as they arrive; get whole video frames out.

export interface AvcConfig {
  /** The AVCDecoderConfigurationRecord, as an MP4 avcC box holds it. */
  avcC: Buffer;
}

export interface AvcFrame {
  /** Decode time, ms. */
  dts: number;
  /** Composition offset, ms. */
  cts: number;
  key: boolean;
  /** Length-prefixed NAL units, as an MP4 sample holds them. */
  data: Buffer;
}

export class FlvError extends Error {}

const MAX_TAG = 8 * 1024 * 1024;

export class FlvReader {
  private buf: Buffer = Buffer.alloc(0);
  private headerDone = false;

  constructor(
    private readonly onConfig: (c: AvcConfig) => void,
    private readonly onFrame: (f: AvcFrame) => void
  ) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let at = 0;
    if (!this.headerDone) {
      if (this.buf.length < 13) return;
      if (this.buf.toString('latin1', 0, 3) !== 'FLV') throw new FlvError('Not an FLV stream');
      at = this.buf.readUInt32BE(5) + 4; // header, then PreviousTagSize0
      this.headerDone = true;
    }
    while (this.buf.length - at >= 11) {
      const type = this.buf[at]! & 0x1f;
      const size = this.buf.readUIntBE(at + 1, 3);
      if (size > MAX_TAG) throw new FlvError('FLV tag too large');
      if (this.buf.length - at < 11 + size + 4) break;
      const ts = (this.buf.readUIntBE(at + 4, 3) | (this.buf[at + 7]! << 24)) >>> 0;
      if (type === 9) this.video(ts, this.buf.subarray(at + 11, at + 11 + size));
      at += 11 + size + 4;
    }
    this.buf = at >= this.buf.length ? Buffer.alloc(0) : Buffer.from(this.buf.subarray(at));
  }

  private video(ts: number, d: Buffer): void {
    if (d.length < 5 || (d[0]! & 0x0f) !== 7) return; // AVC only
    const key = d[0]! >> 4 === 1;
    const packet = d[1]!;
    if (packet === 0) return this.onConfig({ avcC: Buffer.from(d.subarray(5)) });
    if (packet !== 1) return;
    const cts = (d.readIntBE(2, 3));
    this.onFrame({ dts: ts, cts, key, data: Buffer.from(d.subarray(5)) });
  }
}
