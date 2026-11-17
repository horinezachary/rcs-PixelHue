// Who is watching which preview stream. A panel or web view asks for the streams it needs every few seconds
// while it shows live canvases; a stream nobody has asked for lately stops, so the module pulls nothing from
// the switcher when no one is looking.

import { EchoRelay, type Segment } from './relay.js';

/** A viewer that hasn't asked again for this long has gone. */
export const VIEWER_TTL_MS = 15_000;
/** UI messages are capped at 64 KB: send fragments in base64 parts below that. */
export const PART_BYTES = 40_000;
/** A viewer this many messages behind skips ahead to the next keyframe. */
const MAX_BEHIND = 40;

export interface Source {
  sw: string;
  host: string;
  port: number;
  index: number;
  path: string;
  width: number;
  height: number;
}

interface Viewer {
  seen: number;
  /** Messages handed to send and not yet done. */
  behind: number;
  chain: Promise<void>;
  /** Skipping until a keyframe. */
  skip: boolean;
}

interface Feed {
  src: Source;
  relay: EchoRelay;
  viewers: Map<string, Viewer>;
}

export type Send = (message: unknown, clientId: string) => Promise<void>;

export class VideoHub {
  private feeds = new Map<string, Feed>();
  private timer: NodeJS.Timeout;

  constructor(
    private readonly send: Send,
    private readonly now = () => Date.now()
  ) {
    this.timer = setInterval(() => this.prune(), 5000);
    this.timer.unref?.();
  }

  private static key(s: Source): string {
    return `${s.sw}|${s.host}|${s.port}|${s.path}|${s.width}x${s.height}`;
  }

  /** The streams this viewer wants now; any it had before and doesn't list stop for it. */
  want(clientId: string, sources: Source[]): void {
    const keys = new Set(sources.map(VideoHub.key));
    for (const [k, f] of this.feeds) if (!keys.has(k)) f.viewers.delete(clientId);
    for (const src of sources) {
      const k = VideoHub.key(src);
      let f = this.feeds.get(k);
      if (!f) {
        const relay = new EchoRelay(src.host, src.port, src.path, src.width, src.height);
        const feed: Feed = { src, relay, viewers: new Map() };
        relay.on('init', () => {
          for (const [id, v] of feed.viewers) this.sendInit(feed, id, v);
        });
        relay.on('segment', (seg: Segment) => {
          for (const [id, v] of feed.viewers) this.sendSegment(feed, id, v, seg);
        });
        f = feed;
        this.feeds.set(k, f);
        relay.start();
      }
      const v = f.viewers.get(clientId);
      if (v) {
        v.seen = this.now();
        continue;
      }
      const nv: Viewer = { seen: this.now(), behind: 0, chain: Promise.resolve(), skip: false };
      f.viewers.set(clientId, nv);
      // A late joiner starts from the last keyframe.
      if (f.relay.init) {
        this.sendInit(f, clientId, nv);
        for (const seg of f.relay.gop) this.sendSegment(f, clientId, nv, seg);
      }
    }
    this.prune();
  }

  drop(clientId: string): void {
    for (const f of this.feeds.values()) f.viewers.delete(clientId);
    this.prune();
  }

  /** Streams running now, for tests and status. */
  running(): Source[] {
    return [...this.feeds.values()].map((f) => f.src);
  }

  stop(): void {
    clearInterval(this.timer);
    for (const f of this.feeds.values()) f.relay.stop();
    this.feeds.clear();
  }

  private prune(): void {
    const t = this.now();
    for (const [k, f] of this.feeds) {
      for (const [id, v] of f.viewers) if (t - v.seen > VIEWER_TTL_MS) f.viewers.delete(id);
      if (!f.viewers.size) {
        f.relay.stop();
        this.feeds.delete(k);
      }
    }
  }

  private sendInit(f: Feed, clientId: string, v: Viewer): void {
    const init = f.relay.init!;
    v.skip = false;
    this.queue(f, clientId, v, { kind: 'init', mime: init.mime, seq: 0 }, init.data);
  }

  private sendSegment(f: Feed, clientId: string, v: Viewer, seg: Segment): void {
    if (v.behind > MAX_BEHIND) v.skip = true;
    if (v.skip && !seg.key) return;
    v.skip = false;
    this.queue(f, clientId, v, { kind: 'seg', seq: seg.seq, key: seg.key }, seg.data);
  }

  private queue(f: Feed, clientId: string, v: Viewer, head: Record<string, unknown>, data: Buffer): void {
    const parts = Math.max(1, Math.ceil(data.length / PART_BYTES));
    for (let part = 0; part < parts; part++) {
      const message = {
        type: 'video',
        sw: f.src.sw,
        stream: f.src.index,
        ...head,
        part,
        parts,
        data: data.subarray(part * PART_BYTES, (part + 1) * PART_BYTES).toString('base64')
      };
      v.behind++;
      v.chain = v.chain
        .then(() => this.send(message, clientId))
        .catch(() => {})
        .finally(() => {
          v.behind--;
        });
    }
  }
}
