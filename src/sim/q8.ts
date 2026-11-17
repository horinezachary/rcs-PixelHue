// A simulated PixelHue Q8 for development and tests: the discovery port (HTTPS, self-signed) and the Open API
// port, with the same request and reply shapes as a real switcher (PixelFlow OpenAPI manual V2.0.1, PixelHue's
// Companion module and a PixelFlow virtual Q8 capture). It holds screens, layers on PGM and PVW, inputs and
// presets, and acts on preset/apply, screen/take and screen/cut. Nothing here talks to real equipment.
//
// Development hooks on the API port (not part of the real API):
//   GET /sim/signal?input=<interfaceId>&state=<0|1>   unplug or plug an input
//   GET /sim/restart                                   new start time, so old tokens stop working
//   GET /sim/select?screen=<screenId>&on=<0|1>         select a screen as the front panel would
//
// Input preview, as a real Q8: GET layers/echo lists the streams and where each input sits in them, and
// GET /flv1 (no token) is a live HTTP-FLV stream, looped from sim/echo.flv (scripts/make-sim-video.mjs).

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { makeToken } from '../q8/client.js';
import { SIM_CERT, SIM_KEY } from './cert.js';

interface SimInput {
  id: number;
  name: string;
  state: number;
  w: number;
  h: number;
  sdi: boolean;
}
interface SimOutput {
  id: number;
  name: string;
}
interface SimScreen {
  id: number;
  type: number;
  name: string;
  guid: string;
  x: number;
  w: number;
  h: number;
  outputs: number[];
  select: 0 | 1;
}
interface SimLayer {
  inputId: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface SimPreset {
  guid: string;
  serial: number;
  name: string;
  region: number;
  content: Record<number, SimLayer[]>; // screenId -> layers
}

export interface SimOptions {
  name?: string;
  serial?: string;
  /** Model id the device reports. 29974: Q8. */
  modelId?: number;
}

export class Q8Simulator {
  readonly name: string;
  readonly serial: string;
  readonly modelId: number;
  startTime = String(Date.now());
  /** Every write the API port took: path and body. */
  readonly writes: { path: string; body: unknown }[] = [];
  /** Requests refused for a missing or wrong token. */
  unauthorized = 0;
  private discovery: https.Server | null = null;
  private api: http.Server | null = null;
  apiPort = 0;
  private host = '127.0.0.1';

  inputs: SimInput[] = [
    ['Cam 1 Wide', 1, 1920, 1080, true],
    ['Cam 2 Tight', 1, 1920, 1080, true],
    ['Cam 3 Handheld', 1, 1920, 1080, true],
    ['Cam 4 Jib', 0, 0, 0, true],
    ['Playback A', 1, 3840, 2160, false],
    ['Playback B', 1, 3840, 2160, false],
    ['Lectern Laptop', 1, 1920, 1200, false],
    ['Presenter Notes', 1, 1920, 1080, false],
    ['Graphics Fill', 1, 1920, 1080, false],
    ['Graphics Key', 1, 1920, 1080, false],
    ['Spare HDMI', 0, 0, 0, false],
    ['Spare DP', 0, 0, 0, false]
  ].map(([name, state, w, h, sdi], i) => ({ id: i + 1, name: name as string, state: state as number, w: w as number, h: h as number, sdi: sdi as boolean }));

  outputs: SimOutput[] = ['OUT 1-1', 'OUT 1-2', 'OUT 1-3', 'OUT 1-4', 'OUT 2-1', 'OUT 2-2', 'OUT 2-3', 'MVR 1'].map((name, i) => ({ id: 101 + i, name }));

  screens: SimScreen[] = [
    { id: 1, type: 2, name: 'LED Wall', guid: randomUUID(), x: 0, w: 3840, h: 1080, outputs: [101, 102, 103, 104], select: 0 },
    { id: 2, type: 2, name: 'IMAG Left', guid: randomUUID(), x: 3840, w: 1920, h: 1080, outputs: [105], select: 0 },
    { id: 3, type: 2, name: 'IMAG Right', guid: randomUUID(), x: 5760, w: 1920, h: 1080, outputs: [106], select: 0 },
    { id: 4, type: 4, name: 'Confidence', guid: randomUUID(), x: 7680, w: 1920, h: 1080, outputs: [107], select: 0 },
    { id: 5, type: 8, name: 'MVR 1', guid: '', x: 0, w: 1920, h: 1080, outputs: [108], select: 0 },
    { id: 6, type: 16, name: '', guid: '', x: 0, w: 0, h: 0, outputs: [], select: 0 }
  ];

  /** Layers on each screen, by scene: 2 PGM, 4 PVW. */
  scene: Record<2 | 4, Record<number, SimLayer[]>> = { 2: {}, 4: {} };
  /** Multiviewer windows: input per window, in a 4×3 grid. */
  mvr: number[] = [1, 2, 3, 4, 5, 6, 7, 8, -2, -4, 9, 10];

  presets: SimPreset[];

  constructor(opts: SimOptions = {}) {
    this.name = opts.name ?? 'Q8 Main';
    this.serial = opts.serial ?? 'Q8SIM0001';
    this.modelId = opts.modelId ?? 29974;
    const wall = (inputId: number, ...pip: [number, number, number, number, number][]): SimLayer[] => [
      { inputId, x: 0, y: 0, w: 3840, h: 1080 },
      ...pip.map(([id, x, y, w, h]) => ({ inputId: id, x, y, w, h }))
    ];
    const one = (inputId: number): SimLayer[] => [{ inputId, x: 0, y: 0, w: 1920, h: 1080 }];
    const mk = (serial: number, name: string, content: Record<number, SimLayer[]>): SimPreset => ({ guid: randomUUID(), serial, name, region: 0, content });
    this.presets = [
      mk(1, 'Walk In', { 1: wall(5), 2: one(5), 3: one(5) }),
      mk(2, 'Keynote', { 1: wall(5, [7, 1200, 140, 1440, 810]), 2: one(1), 3: one(2) }),
      mk(3, 'Keynote Full', { 1: wall(7), 2: one(1), 3: one(2) }),
      mk(4, 'Panel', { 1: wall(6, [1, 160, 200, 1120, 630], [2, 1360, 200, 1120, 630], [3, 2560, 200, 1120, 630]), 2: one(1), 3: one(3) }),
      mk(5, 'Video Roll', { 1: wall(6), 2: one(6), 3: one(6) }),
      mk(6, 'Q&A', { 1: wall(5, [3, 1360, 140, 1120, 630]), 2: one(3), 3: one(3) }),
      mk(7, 'IMAG Only', { 2: one(1), 3: one(2) }),
      mk(8, 'Confidence', { 4: one(8) }),
      mk(9, 'Break', { 1: wall(9, [10, 0, 0, 3840, 1080]), 2: one(9), 3: one(9) }),
      mk(10, 'Walk Out', { 1: wall(6), 2: one(6), 3: one(6) }),
      mk(11, 'Sponsor Loop', { 1: wall(5), 2: one(5), 3: one(5) }),
      mk(12, 'Black', { 1: [], 2: [], 3: [] })
    ];
    // Show running: Walk In on program, Keynote on preview.
    this.load(this.presets[0]!, 2);
    this.load(this.presets[1]!, 4);
    this.scene[2][4] = one(8);
    this.scene[4][4] = one(8);
  }

  token(): string {
    return makeToken(this.serial, this.startTime);
  }

  async listen(discoveryPort = 0, apiPort = 0, host = '127.0.0.1'): Promise<{ discovery: number; api: number }> {
    this.host = host;
    this.api = http.createServer((req, res) => this.handleApi(req, res));
    await new Promise<void>((r) => this.api!.listen(apiPort, host, r));
    this.apiPort = (this.api.address() as AddressInfo).port;
    this.discovery = https.createServer({ key: SIM_KEY, cert: SIM_CERT }, (req, res) => this.handleDiscovery(req, res));
    await new Promise<void>((r) => this.discovery!.listen(discoveryPort, host, r));
    return { discovery: (this.discovery.address() as AddressInfo).port, api: this.apiPort };
  }

  async close(): Promise<void> {
    const shut = (s: http.Server | https.Server | null) =>
      new Promise<void>((r) => {
        if (!s) return r();
        s.closeAllConnections?.();
        s.close(() => r());
      });
    await Promise.all([shut(this.api), shut(this.discovery)]);
    this.api = this.discovery = null;
  }

  // ---- input preview ----------------------------------------------------------------------------

  /** Viewers of /flv1 now. */
  echoViewers = 0;

  private echoList() {
    const tile = (i: number) => ({
      window: { width: 320, height: 180, x: Math.floor(i / 4) * 320, y: (i % 4) * 180 },
      source: { sourceType: 2, sourceId: this.inputs[i]!.id, relationId: 0, osd: { componentId: '', componentType: 0 }, ipcLayout: [], cropInfo: { needCrop: 0, windows: null } },
      type: 0,
      screenIndex: 0
    });
    return [
      { index: 0, type: 2, url: '/flv1', frame: 20, width: 1280, height: 720, urlType: 0, echoLayout: this.inputs.map((_, i) => tile(i)) },
      { index: 1, type: 2, url: '/flv2', frame: 20, width: 1280, height: 720, urlType: 0, echoLayout: [] }
    ];
  }

  /** The looped FLV, sent at its own pace with timestamps that keep rising, as a live stream. */
  private streamEcho(res: http.ServerResponse): void {
    const flv = echoFile();
    if (!flv) return send(res, 404, { code: 404, message: 'no sim/echo.flv' });
    res.writeHead(200, { 'Content-Type': 'video/x-flv', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    res.write(flv.header);
    res.write(flv.config);
    this.echoViewers++;
    let i = 0;
    let loop = 0;
    const start = Date.now();
    let timer: NodeJS.Timeout | null = null;
    const next = () => {
      if (res.destroyed) return;
      const t = flv.tags[i]!;
      const ts = loop * flv.length + t.ts;
      const wait = start + ts - Date.now();
      if (wait > 5) {
        timer = setTimeout(next, wait);
        return;
      }
      res.write(withTimestamp(t.data, ts));
      if (++i === flv.tags.length) {
        i = 0;
        loop++;
      }
      setImmediate(next);
    };
    res.on('close', () => {
      this.echoViewers--;
      if (timer) clearTimeout(timer);
    });
    next();
  }

  // ---- behaviour --------------------------------------------------------------------------------

  private load(p: SimPreset, region: 2 | 4): void {
    for (const [sid, layers] of Object.entries(p.content)) this.scene[region][Number(sid)] = layers.map((l) => ({ ...l }));
    // The region bits: 2 PGM, 4 PVW, 6 both.
    for (const o of this.presets) if (o !== p) o.region &= ~region;
    p.region |= region;
    if (region === 4) for (const s of this.screens) s.select = String(s.id) in p.content ? 1 : 0;
  }

  /** PVW to PGM on these screens, swapping, as Take and Cut do with swapEnable 1. */
  private transition(ids: number[]): void {
    for (const id of ids) {
      const pgm = this.scene[2][id] ?? [];
      this.scene[2][id] = this.scene[4][id] ?? [];
      this.scene[4][id] = pgm;
    }
    // A preset whose screens all moved swaps its tally.
    for (const p of this.presets) {
      const ids2 = Object.keys(p.content).map(Number);
      if (!ids2.length || !ids2.every((i) => ids.includes(i))) continue;
      const pv = (p.region & 4) !== 0;
      const pg = (p.region & 2) !== 0;
      if (pv !== pg) p.region = pv ? 2 : 4;
    }
  }

  // ---- shapes, as a switcher reports them -------------------------------------------------------

  private interfaceList() {
    const timing = (w: number, h: number) => ({ interlaced: 0, horizontal: { addTime: w }, vertical: { addTime: h }, refresh: w ? 60 : 0 });
    return [
      ...this.inputs.map((i) => ({
        interfaceId: i.id,
        interfaceIdObj: { slotId: Math.floor((i.id - 1) / 4), connectorId: (i.id - 1) % 4, splitId: 0, nodeId: 1 },
        general: { name: i.name },
        state: i.state,
        actualTiming: timing(i.w, i.h),
        auxiliaryInfo: { online: 1, connectorInfo: { interfaceType: 2, type: i.sdi ? 13 : 6, capacity: 2, workMode: 0 } }
      })),
      ...this.outputs.map((o) => ({
        interfaceId: o.id,
        interfaceIdObj: { slotId: 8, connectorId: o.id - 101, splitId: 0, nodeId: 1 },
        general: { name: o.name },
        state: 1,
        auxiliaryInfo: { online: 1, connectorInfo: { interfaceType: o.name.startsWith('MVR') ? 4 : 3, type: 6, capacity: 2, workMode: 0 } }
      }))
    ];
  }

  private screenList() {
    return this.screens.map((s) => ({
      screenId: s.id,
      screenIdObj: { id: s.id - 1, type: s.type },
      guid: s.guid,
      general: { name: s.name },
      select: s.select,
      freeze: 0,
      enable: 1,
      ftb: { enable: 0, time: 500 },
      mosaic: { window: { x: s.x, y: 0, width: s.w, height: s.h }, outputs: s.outputs.map((id) => ({ interfaceId: id })) },
      timing: { horizontal: { addTime: s.w }, vertical: { addTime: s.h }, refresh: 60 }
    }));
  }

  private layerList() {
    const out: unknown[] = [];
    let id = 1;
    const source = (inputId: number) => {
      // As a real Q8: a multiviewer tile of a screen's PGM (3) or PVW (4) names the screen, by id.
      const wall = this.screens.find((x) => x.type === 2)!;
      if (inputId === -2) return { sourceId: wall.id, sourceType: 3, sourceName: wall.name };
      if (inputId === -4) return { sourceId: wall.id, sourceType: 4, sourceName: wall.name };
      const i = this.inputs.find((x) => x.id === inputId);
      return { sourceId: inputId, sourceType: 2, sourceName: i?.name ?? '' };
    };
    for (const sceneType of [2, 4] as const) {
      for (const s of this.screens.filter((x) => x.type === 2 || x.type === 4)) {
        (this.scene[sceneType][s.id] ?? []).forEach((l, z) =>
          out.push({
            layerId: id++,
            layerIdObj: { id: z, type: s.type === 4 ? 4 : 2, attachScreenId: s.id, attachScreenType: 0, sceneType, screenGuid: s.guid },
            general: { name: `Layer ${z + 1}` },
            source: { general: source(l.inputId) },
            window: { x: l.x + s.x, y: l.y, width: l.w, height: l.h },
            zorder: z,
            enable: 1,
            serial: z + 1
          })
        );
      }
    }
    const mvr = this.screens.find((s) => s.type === 8)!;
    this.mvr.forEach((inputId, n) =>
      out.push({
        layerId: id++,
        layerIdObj: { id: n, type: 8, attachScreenId: mvr.id, attachScreenType: 0, sceneType: 2, screenGuid: '' },
        general: { name: `Window ${n + 1}` },
        source: { general: source(inputId) },
        window: { x: (n % 4) * 480, y: Math.floor(n / 4) * 360, width: 480, height: 360 },
        zorder: n,
        enable: 1,
        serial: n + 1
      })
    );
    return out;
  }

  private presetList() {
    return this.presets.map((p) => ({
      guid: p.guid,
      serial: p.serial,
      name: p.name,
      currentRegion: p.region,
      sourceRegion: 0,
      screens: Object.keys(p.content).map((sid) => {
        const s = this.screens.find((x) => x.id === Number(sid))!;
        return { guid: s.guid, screenIdObj: { id: s.id - 1, type: s.type }, general: { name: s.name } };
      })
    }));
  }

  // ---- HTTP ---------------------------------------------------------------------------------------

  private handleDiscovery(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'https://sim');
    if (req.method === 'GET' && url.pathname === '/unico/v1/ucenter/device-list') {
      return send(res, 200, ok({ list: [{ SN: this.serial, modelId: this.modelId, deviceName: this.name, ip: this.host, protocols: [{ linkType: 'http', port: this.apiPort }] }], totalCount: 1 }));
    }
    send(res, 404, { code: 404, message: 'not found' });
  }

  private handleApi(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://sim');
    const path = url.pathname;
    if (path.startsWith('/sim/')) return this.handleSim(path, url, res);
    if (req.method === 'GET' && path === '/flv1') return this.streamEcho(res);
    if (req.method === 'GET' && path === '/unico/v1/node/open-detail') return send(res, 200, ok({ sn: this.serial, startTime: this.startTime }));
    if (req.headers.authorization !== this.token()) {
      this.unauthorized++;
      return send(res, 200, { code: 8199, message: 'token invalid', data: {} });
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: any;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      } catch {
        return send(res, 400, { code: 400, message: 'bad json' });
      }
      const route = `${req.method} ${path.replace('/unico/v1/', '')}`;
      switch (route) {
        case 'GET screen/list-detail':
          return send(res, 200, ok({ list: this.screenList(), totalCount: this.screens.length }));
        case 'GET layers/list-detail':
          return send(res, 200, ok({ list: this.layerList() }));
        case 'GET preset':
          return send(res, 200, ok({ list: this.presetList(), totalCount: this.presets.length }));
        case 'GET interface/list-detail':
          return send(res, 200, ok({ list: this.interfaceList() }));
        case 'GET layers/echo':
          return send(res, 200, { code: 0, message: 'ok', data: this.echoList() });
        case 'GET layers/echo/status':
          return send(res, 200, ok({ nodeId: 1, status: 1 }));
      }
      if (req.method === 'GET') return send(res, 200, { code: 404, message: `unknown ${path}`, data: {} });
      this.writes.push({ path: route, body });
      switch (route) {
        case 'POST preset/apply': {
          const p = this.presets.find((x) => x.guid === body?.presetId || (!body?.presetId && x.serial === body?.serial));
          if (!p || ![2, 4].includes(body?.targetRegion)) return send(res, 200, { code: 4001, message: 'preset not found', data: {} });
          this.load(p, body.targetRegion);
          return send(res, 200, ok({}));
        }
        case 'PUT screen/take':
        case 'PUT screen/cut': {
          const ids = (Array.isArray(body) ? body : []).map((b: any) => Number(b?.screenId)).filter((id: number) => this.screens.some((s) => s.id === id && (s.type === 2 || s.type === 4)));
          if (!ids.length) return send(res, 200, { code: 4002, message: 'no screen', data: {} });
          this.transition(ids);
          return send(res, 200, ok({}));
        }
      }
      send(res, 200, { code: 404, message: `unknown ${route}`, data: {} });
    });
  }

  private handleSim(path: string, url: URL, res: http.ServerResponse): void {
    if (path === '/sim/signal') {
      const i = this.inputs.find((x) => x.id === Number(url.searchParams.get('input')));
      if (!i) return send(res, 404, { error: 'no such input' });
      i.state = Number(url.searchParams.get('state')) ? 1 : 0;
      [i.w, i.h] = i.state ? [1920, 1080] : [0, 0];
      return send(res, 200, { ok: true });
    }
    if (path === '/sim/restart') {
      this.startTime = String(Date.now() + 1);
      return send(res, 200, { ok: true });
    }
    if (path === '/sim/select') {
      const s = this.screens.find((x) => x.id === Number(url.searchParams.get('screen')));
      if (!s) return send(res, 404, { error: 'no such screen' });
      s.select = Number(url.searchParams.get('on')) ? 1 : 0;
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'unknown' });
  }
}

const ok = (data: unknown) => ({ code: 0, message: 'ok', data });

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

// ---- the looped preview file --------------------------------------------------------------------

interface EchoFile {
  header: Buffer;
  /** The AVC sequence header tag (with its PreviousTagSize). */
  config: Buffer;
  /** Video frame tags (each with its PreviousTagSize) and their timestamps, ms. */
  tags: { ts: number; data: Buffer }[];
  /** One loop, ms. */
  length: number;
}

let echoCache: EchoFile | null | undefined;

function echoFile(): EchoFile | null {
  if (echoCache !== undefined) return echoCache;
  try {
    const b = readFileSync(new URL('../../sim/echo.flv', import.meta.url));
    const headerEnd = b.readUInt32BE(5) + 4;
    const out: EchoFile = { header: b.subarray(0, headerEnd), config: Buffer.alloc(0), tags: [], length: 0 };
    for (let at = headerEnd; at + 11 <= b.length; ) {
      const size = b.readUIntBE(at + 1, 3);
      const data = b.subarray(at, at + 11 + size + 4);
      const ts = b.readUIntBE(at + 4, 3);
      if (b[at] === 9 && b[at + 12] === 0) out.config = data;
      else if (b[at] === 9) out.tags.push({ ts, data });
      at += 11 + size + 4;
    }
    const last = out.tags[out.tags.length - 1]?.ts ?? 0;
    out.length = last + (out.tags.length > 1 ? last / (out.tags.length - 1) : 200);
    echoCache = out.tags.length && out.config.length ? out : null;
  } catch {
    echoCache = null;
  }
  return echoCache;
}

function withTimestamp(tag: Buffer, ts: number): Buffer {
  const t = Buffer.from(tag);
  t.writeUIntBE(ts & 0xffffff, 4, 3);
  t[7] = (ts >>> 24) & 0xff;
  return t;
}
