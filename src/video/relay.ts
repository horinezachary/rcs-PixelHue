// Pulls one of the switcher's input preview streams (a GET of http://<host>:<api port>/flvN, which needs no
// token) and repackages it as fragmented MP4 for the panel and web view, which play it with Media Source
// Extensions. Reads only. The switcher serves one stream however many people watch: every viewer gets the
// same fragments, and a viewer who joins late gets the init segment and the fragments since the last keyframe.

import { EventEmitter } from 'node:events';
import http from 'node:http';
import { FlvReader, type AvcFrame } from './flv.js';
import { fragment, initSegment, mimeOf } from './fmp4.js';

export interface Segment {
  seq: number;
  key: boolean;
  data: Buffer;
}

/** No bytes for this long: the stream has stalled, start it again. */
const STALL_MS = 10_000;
const RETRY_MS = 3_000;
/** Frame length when a frame's successor is too far off to say (a Q8 runs at about 5 fps). */
const DEFAULT_MS = 200;

export class EchoRelay extends EventEmitter {
  init: { mime: string; data: Buffer } | null = null;
  /** The fragments since the last keyframe, for a viewer who joins now. */
  gop: Segment[] = [];
  error = '';
  private req: http.ClientRequest | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stall: NodeJS.Timeout | null = null;
  private running = false;
  private seq = 1;
  private pending: AvcFrame | null = null;
  /** Shifts the switcher's timestamps so they keep rising across reconnects. */
  private base = 0;
  private last = 0;

  constructor(
    readonly host: string,
    readonly port: number,
    readonly path: string,
    readonly width: number,
    readonly height: number
  ) {
    super();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.open();
  }

  stop(): void {
    this.running = false;
    this.close();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private close(): void {
    if (this.stall) clearTimeout(this.stall);
    this.stall = null;
    this.req?.destroy();
    this.req = null;
  }

  private again(why: string): void {
    this.close();
    this.error = why;
    if (!this.running || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.running) this.open();
    }, RETRY_MS);
  }

  private open(): void {
    this.pending = null;
    let first = -1;
    const reader = new FlvReader(
      (c) => {
        const mime = mimeOf(c.avcC);
        const data = initSegment(c.avcC, this.width, this.height);
        if (!this.init || !this.init.data.equals(data)) {
          this.init = { mime, data };
          this.gop = [];
          this.emit('init', this.init);
        }
      },
      (f) => {
        if (first < 0) first = f.dts;
        this.frame({ ...f, dts: this.base + (f.dts - first) });
      }
    );
    const req = http.get({ host: this.host, port: this.port, path: this.path, headers: { Accept: 'video/x-flv' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return this.again(`HTTP ${res.statusCode} from ${this.path}`);
      }
      this.error = '';
      this.kick();
      res.on('data', (chunk: Buffer) => {
        this.kick();
        try {
          reader.push(chunk);
        } catch (e) {
          this.again((e as Error).message);
        }
      });
      res.on('end', () => this.again('The stream ended'));
      res.on('error', (e) => this.again(e.message));
    });
    req.on('error', (e) => this.again(e.message));
    this.req = req;
    // After a reconnect, carry on from where the last stream left off.
    this.base = this.last + DEFAULT_MS;
  }

  private kick(): void {
    if (this.stall) clearTimeout(this.stall);
    this.stall = setTimeout(() => this.again('The stream stalled'), STALL_MS);
  }

  /** Frames go out one behind, so each knows how long it lasts. */
  private frame(f: AvcFrame): void {
    if (!this.init) return;
    const p = this.pending;
    this.pending = f;
    this.last = f.dts;
    if (!p) return;
    const gap = f.dts - p.dts;
    const seg: Segment = { seq: this.seq++, key: p.key, data: fragment(this.seq - 1, p, gap > 0 && gap < 2000 ? gap : DEFAULT_MS) };
    if (seg.key) this.gop = [];
    // A stream that opens on a non-key frame can't be decoded from there: wait for a keyframe.
    if (!seg.key && !this.gop.length) return;
    this.gop.push(seg);
    this.emit('segment', seg);
  }
}
