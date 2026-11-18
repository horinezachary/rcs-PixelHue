// PixelHue Switcher: recall a PixelHue Q8's presets to preview from the Stream Deck, Take or Cut them to
// program, and see which input is on every screen, output and multiviewer window.
//
// The switcher is the source of truth. Everything read from it is kept only in memory: state holds which
// switcher the panel works on and where a preset key loads (preview or program); config holds the switcher
// list, Allow controls and the transition time. Starting, restoring a save, resuming after a power cut and
// reconnecting only read. A command goes out only on an operator's action, and only with Allow controls on.
//
// The switcher's API takes no login (the token comes from its serial number and start time), so the module
// keeps no secrets.
//
// Stream Deck:
//   keys 1-10  presets (key 10 pages when there are more than 10). Lit green on preview, red on program.
//              Press: load to preview. With "Load to PGM", the first press arms and a second within 3 s sends.
//   key 11     load to: PVW or PGM (the module's own setting; sends nothing)
//   key 12     switcher (when there are several): press for the next one
//   key 13     what is on preview; press for the Outputs view
//   key 14     CUT    key 15  TAKE  (on the screens selected on the switcher)
//
// On a larger deck (controller 0.21.0+) presets fill every row but the bottom one, and the bottom row
// keeps LOAD TO and the switcher key first and PREVIEW, CUT and TAKE last, with more presets in between.

import { randomBytes } from 'node:crypto';
import { defineModule, type Ctx, type KeySetParams } from '@rcs/module-sdk';
import type { PresetView } from './q8/model.js';
import { VideoHub, type Source } from './video/hub.js';
import { CommandError, Switcher, type Command, type SwitcherEntry, type SwitcherView } from './switcher.js';

export interface State {
  /** Id of the switcher the panel and keys work on. */
  sw: string;
  /** Where a preset key loads. */
  target: 'pvw' | 'pgm';
}

export interface Config {
  switchers: SwitcherEntry[];
  /** Lets the operator send commands. Off: the module only reads. */
  allowControls: boolean;
  /** Transition time for Take and preset loads, ms. 0: the switcher's own. */
  transitionMs: number;
  /** Draw canvases from the switcher's live input preview (a read: the module only pulls it while someone watches). */
  video: boolean;
}

type C = Ctx<State, Config>;
export type View = 'presets' | 'outputs' | 'inputs' | 'setup';
const VIEWS: View[] = ['presets', 'outputs', 'inputs', 'setup'];

export const KEY = { PRESETS: 10, TARGET: 10, SWITCHER: 11, PVW: 12, CUT: 13, TAKE: 14 } as const;

export interface Grid {
  columns: number;
  rows: number;
}

/** The deck as the controller describes it. Older controllers send no size: 5 × 3. */
export function grid(ctx: { host: { deck: { columns?: number; rows?: number } } }): Grid {
  return { columns: ctx.host.deck.columns ?? 5, rows: ctx.host.deck.rows ?? 3 };
}

export interface Layout {
  keys: number;
  /** Preset keys in order; the last one pages when there are more presets than keys. */
  presets: number[];
  target: number;
  switcher: number;
  pvw: number;
  cut: number;
  take: number;
}

/** Where everything goes on a deck of this size. On 5 × 3 it is KEY. */
export function layout(g: Grid): Layout {
  const keys = g.columns * g.rows;
  const bottom = (g.rows - 1) * g.columns;
  const presets = Array.from({ length: bottom }, (_, i) => i);
  for (let k = bottom + 2; k < keys - 3; k++) presets.push(k);
  return { keys, presets, target: bottom, switcher: bottom + 1, pvw: keys - 3, cut: keys - 2, take: keys - 1 };
}
export const MAX_SWITCHERS = 4;
/** Loading straight to program fires on a second press within this time. */
export const CONFIRM_MS = 3000;
const pollMs = () => Number(process.env.RCS_PIXELHUE_POLL_MS) || 1000;
const timeoutMs = () => Number(process.env.RCS_PIXELHUE_TIMEOUT_MS) || 3000;

const PVW_BG = '#12602E';
const PGM_BG = '#8A1C1C';
const ARMED = '#3A2A0E';
const ON = '#FFFFFF';

interface Armed {
  key: number;
  sw: string;
  cmd: Command;
  what: string;
  timer: NodeJS.Timeout;
}

interface Runtime {
  switchers: Map<string, Switcher>;
  view: View;
  presetPage: number;
  armed: Armed | null;
  busy: boolean;
  drawTimer: NodeJS.Timeout | null;
  video: VideoHub;
}
let rt: Runtime | null = null;

const ADDRESS_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:]+\]?$/;
export const validAddress = (a: unknown): a is string => typeof a === 'string' && a !== '' && ADDRESS_RE.test(a);

function cleanEntry(e: any): SwitcherEntry | null {
  if (!e || typeof e.id !== 'string' || !validAddress(e.host)) return null;
  const port = Number.isInteger(e.port) && e.port >= 0 && e.port <= 65535 ? e.port : 0;
  return { id: e.id, host: e.host, port, label: typeof e.label === 'string' ? e.label.slice(0, 40) : '' };
}

export function cfg(ctx: C): Config {
  const c = (ctx.config ?? {}) as Partial<Config>;
  const t = Number(c.transitionMs);
  return {
    switchers: Array.isArray(c.switchers) ? c.switchers.map(cleanEntry).filter((e): e is SwitcherEntry => !!e).slice(0, MAX_SWITCHERS) : [],
    allowControls: c.allowControls ?? false,
    transitionMs: Number.isInteger(t) && t >= 0 && t <= 10000 ? t : 0,
    video: c.video ?? true
  };
}

const quiet = (p: Promise<unknown>): void => void p.catch(() => {});
const short = (s: string | undefined, n: number): string => [...(s ?? '')].slice(0, n).join('');
const views = (): SwitcherView[] => (rt ? [...rt.switchers.values()].map((s) => s.view) : []);

function currentSwitcher(ctx: C): Switcher | undefined {
  if (!rt) return undefined;
  return rt.switchers.get(ctx.state.value.sw) ?? rt.switchers.values().next().value;
}

function target(ctx: C): 'pvw' | 'pgm' {
  return ctx.state.value.target === 'pgm' ? 'pgm' : 'pvw';
}

// ---- what the screens get ----------------------------------------------------------------------

export function snapshot(ctx: C) {
  const c = cfg(ctx);
  const sw = currentSwitcher(ctx);
  const v = sw?.view;
  return {
    type: 'snapshot',
    view: rt?.view ?? 'presets',
    allowControls: c.allowControls,
    transitionMs: c.transitionMs,
    video: c.video,
    target: target(ctx),
    entries: c.switchers,
    switchers: views().map((s) => ({ id: s.id, name: s.name, host: s.host, model: s.model, serial: s.serial, reachable: s.reachable, read: s.read, lastError: s.lastError })),
    current: v?.id ?? '',
    switcher: v ? { ...v, presets: v.presets.slice(0, 300) } : null,
    takeScreens: sw ? sw.takeScreens().map((s) => s.name) : [],
    presetPage: rt?.presetPage ?? 0,
    armed: rt?.armed ? { key: rt.armed.key, what: rt.armed.what, guid: rt.armed.cmd.action === 'preset' ? rt.armed.cmd.guid : '' } : null,
    busy: rt?.busy ?? false
  };
}

// ---- keys --------------------------------------------------------------------------------------

function presetPaging(n: number, slots: number): { perPage: number; pages: number } {
  const perPage = n > slots ? slots - 1 : slots;
  return { perPage, pages: Math.max(1, Math.ceil(n / perPage)) };
}

function presetOnKey(ctx: C, index: number): PresetView | undefined {
  const list = currentSwitcher(ctx)?.view.presets ?? [];
  const L = layout(grid(ctx));
  const { perPage, pages } = presetPaging(list.length, L.presets.length);
  const slot = L.presets.indexOf(index);
  if (slot < 0 || slot >= perPage) return undefined;
  return list[Math.min(rt?.presetPage ?? 0, pages - 1) * perPage + slot];
}

function keyFaces(ctx: C): KeySetParams[] {
  const c = cfg(ctx);
  const sw = currentSwitcher(ctx);
  const v = sw?.view;
  const faces: KeySetParams[] = [];
  const blank = (index: number): KeySetParams => ({ index });
  const offline = !v?.reachable;
  const armed = rt?.armed && rt.armed.sw === v?.id ? rt.armed.key : -1;
  const armedGuid = rt?.armed && rt.armed.sw === v?.id && rt.armed.cmd.action === 'preset' ? rt.armed.cmd.guid : '';

  const L = layout(grid(ctx));
  const presets = v?.presets ?? [];
  const { perPage, pages } = presetPaging(presets.length, L.presets.length);
  const page = Math.min(rt?.presetPage ?? 0, pages - 1);
  for (const [i, k] of L.presets.entries()) {
    if (i === L.presets.length - 1 && pages > 1) {
      faces.push({ index: k, label: 'MORE ▶', sublabel: `${page + 1} of ${pages}` });
      continue;
    }
    const p = presets[page * perPage + i];
    if (!p) {
      faces.push(blank(k));
      continue;
    }
    const tally = p.region === 'both' ? 'PGM+PVW' : p.region.toUpperCase();
    const f: KeySetParams = { index: k, label: short(p.name.toUpperCase(), 10), sublabel: offline ? 'offline' : tally || `PRESET ${p.serial}` };
    if (armed === k || (armedGuid && armedGuid === p.guid)) Object.assign(f, { sublabel: 'PRESS AGAIN', background: ARMED, color: '#FFE2B0' });
    else if (!offline && (p.region === 'pgm' || p.region === 'both')) Object.assign(f, { background: PGM_BG, color: ON });
    else if (!offline && p.region === 'pvw') Object.assign(f, { background: PVW_BG, color: ON });
    faces.push(f);
  }

  const t = target(ctx);
  faces.push({ index: L.target, label: 'LOAD TO', sublabel: t === 'pgm' ? 'PROGRAM' : 'PREVIEW', ...(t === 'pgm' ? { background: PGM_BG, color: ON } : {}) });

  const list = views();
  faces.push(list.length > 1 && v ? { index: L.switcher, label: short(v.name.toUpperCase(), 10), sublabel: `${list.findIndex((x) => x.id === v.id) + 1} of ${list.length} ▶` } : blank(L.switcher));

  const onPvw = presets.find((p) => p.region === 'pvw');
  faces.push(v ? { index: L.pvw, label: 'PREVIEW', sublabel: offline ? 'offline' : short(onPvw?.name.toUpperCase() ?? '–', 12) } : blank(L.pvw));

  const can = !!v && !offline && (sw?.takeScreens().length ?? 0) > 0;
  faces.push(v ? { index: L.cut, label: 'CUT', sublabel: offline ? 'offline' : can ? '' : 'no screen', ...(can && c.allowControls ? { background: '#2A2F38', color: ON } : {}) } : blank(L.cut));
  faces.push(v ? { index: L.take, label: 'TAKE', sublabel: offline ? 'offline' : can ? '' : 'no screen', ...(can && c.allowControls ? { background: '#C62828', color: ON } : {}) } : blank(L.take));

  // Without Allow controls the keys show the tally and send nothing.
  if (!c.allowControls && v) {
    for (const f of faces) if (f.index === L.take) Object.assign(f, { label: 'VIEW ONLY', sublabel: 'see Setup' });
  }
  return faces;
}

export async function draw(ctx: C, clientId?: string): Promise<void> {
  const snap = snapshot(ctx);
  if (!clientId) {
    if (rt?.drawTimer) clearTimeout(rt.drawTimer);
    if (rt) rt.drawTimer = null;
    await ctx.keys.setMany(keyFaces(ctx));
  }
  await ctx.ui.send(snap, clientId);
}

function soon(ctx: C): void {
  if (!rt || rt.drawTimer) return;
  rt.drawTimer = setTimeout(() => {
    if (!rt) return;
    rt.drawTimer = null;
    quiet(reportStatus(ctx));
    quiet(draw(ctx));
  }, 60);
}

async function reportStatus(ctx: C): Promise<void> {
  const list = views();
  if (!list.length) return ctx.status('disconnected', 'Add a switcher in Setup');
  const up = list.filter((s) => s.reachable).length;
  if (up === list.length) return ctx.status('connected', list.length === 1 ? '' : `${up} switchers`);
  return ctx.status(up ? 'connecting' : 'disconnected', list.length === 1 ? list[0]!.lastError || 'Connecting' : `${up} of ${list.length} switchers answering`);
}

// ---- the module's own state and config: no commands ----------------------------------------------

async function setView(ctx: C, v: unknown): Promise<void> {
  if (!rt || !VIEWS.includes(v as View)) return;
  rt.view = v as View;
  quiet(ctx.strip.select(rt.view));
  await draw(ctx);
}

async function selectSwitcher(ctx: C, id: unknown): Promise<void> {
  if (!rt || typeof id !== 'string' || !rt.switchers.has(id)) return;
  if (id !== ctx.state.value.sw) {
    disarm();
    rt.presetPage = 0;
  }
  await ctx.state.patch({ sw: id });
  await draw(ctx);
}

async function setTarget(ctx: C, t: unknown): Promise<void> {
  disarm();
  await ctx.state.patch({ target: t === 'pgm' ? 'pgm' : 'pvw' });
  await draw(ctx);
}

function newSwitcher(ctx: C, e: SwitcherEntry): Switcher {
  const s = new Switcher(e, pollMs(), timeoutMs());
  s.on('change', () => {
    if (rt?.switchers.get(e.id) === s) soon(ctx);
  });
  return s;
}

/** Brings the running pollers in line with the config. Reads only. */
function sync(ctx: C): void {
  if (!rt) return;
  const entries = cfg(ctx).switchers;
  const next = new Map<string, Switcher>();
  for (const e of entries) {
    const old = rt.switchers.get(e.id);
    if (old && old.entry.host === e.host && old.entry.port === e.port && old.entry.label === e.label) next.set(e.id, old);
    else {
      old?.stop();
      const s = newSwitcher(ctx, e);
      next.set(e.id, s);
      s.start();
    }
  }
  for (const [id, s] of rt.switchers) if (!next.has(id)) s.stop();
  rt.switchers = next;
  quiet(reportStatus(ctx));
}

async function addSwitcher(ctx: C, m: any): Promise<void> {
  const host = typeof m.host === 'string' ? m.host.trim() : '';
  if (!validAddress(host)) return ctx.notify('That is not an IP address or host name', 'warning');
  const port = m.port === undefined || m.port === '' || m.port === null ? 0 : Number(m.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return ctx.notify('Port must be 1 to 65535, or empty for 19998', 'warning');
  const c = cfg(ctx);
  if (c.switchers.some((s) => s.host === host && s.port === port)) return ctx.notify(`${host} is already in the list`);
  if (c.switchers.length >= MAX_SWITCHERS) return ctx.notify(`Up to ${MAX_SWITCHERS} switchers`, 'warning');
  const id = randomBytes(4).toString('hex');
  const label = typeof m.label === 'string' ? m.label.trim().slice(0, 40) : '';
  await ctx.setConfig({ ...c, switchers: [...c.switchers, { id, host, port, label }] });
  await ctx.log('info', `Added switcher ${host}${port ? `:${port}` : ''}`);
  sync(ctx);
  if (!rt?.switchers.has(ctx.state.value.sw)) await ctx.state.patch({ sw: id });
  await draw(ctx);
}

async function editSwitcher(ctx: C, m: any): Promise<void> {
  const c = cfg(ctx);
  const e = c.switchers.find((s) => s.id === m.id);
  if (!e || typeof m.label !== 'string') return;
  await ctx.setConfig({ ...c, switchers: c.switchers.map((s) => (s.id === e.id ? { ...s, label: m.label.trim().slice(0, 40) } : s)) });
  sync(ctx);
  await draw(ctx);
}

async function removeSwitcher(ctx: C, id: unknown): Promise<void> {
  const c = cfg(ctx);
  const e = c.switchers.find((s) => s.id === id);
  if (!e) return;
  await ctx.setConfig({ ...c, switchers: c.switchers.filter((s) => s.id !== e.id) });
  if (rt?.armed?.sw === e.id) disarm();
  await ctx.log('info', `Removed switcher ${e.host}`);
  sync(ctx);
  if (ctx.state.value.sw === e.id) await ctx.state.patch({ sw: cfg(ctx).switchers[0]?.id ?? '' });
  await draw(ctx);
}

async function setAllow(ctx: C, on: unknown): Promise<void> {
  await ctx.setConfig({ ...cfg(ctx), allowControls: !!on });
  if (!on) disarm();
  await ctx.log('info', on ? 'Controls allowed' : 'Controls turned off: the module only reads');
  await draw(ctx);
}

async function setTransition(ctx: C, ms: unknown): Promise<void> {
  const n = Number(ms);
  if (!Number.isInteger(n) || n < 0 || n > 10000) return ctx.notify('Transition time is 0 to 10000 ms (0: the switcher’s own)', 'warning');
  await ctx.setConfig({ ...cfg(ctx), transitionMs: n });
  await draw(ctx);
}

/**
 * A panel or web view showing live canvases asks for the preview streams it needs, every few seconds. Pulling
 * a stream is a read (a GET the switcher serves without a token); it stops when no one has asked for a while.
 */
function watch(ctx: C, clientId: string, m: any): void {
  if (!rt) return;
  const sw = typeof m.sw === 'string' ? rt.switchers.get(m.sw) : undefined;
  const port = sw?.client.session?.apiPort;
  const wanted = Array.isArray(m.streams) ? m.streams.filter((x: unknown) => Number.isInteger(x)).slice(0, 4) : [];
  const sources: Source[] =
    cfg(ctx).video && sw && port && sw.view.reachable
      ? sw.view.echo
          .filter((e) => wanted.includes(e.index))
          .map((e) => ({ sw: sw.view.id, host: sw.client.host, port, index: e.index, path: e.path, width: e.width, height: e.height }))
      : [];
  rt.video.want(clientId, sources);
}

// ---- operator actions: the only things that change the switcher -----------------------------------

function disarm(): void {
  if (!rt?.armed) return;
  clearTimeout(rt.armed.timer);
  rt.armed = null;
}

function describe(cmd: Command, v: SwitcherView): string {
  if (cmd.action === 'preset') {
    const p = v.presets.find((x) => x.guid === cmd.guid);
    return `Load ${p?.name ?? 'preset'} to ${cmd.target === 'pgm' ? 'PROGRAM' : 'preview'}`;
  }
  return cmd.action === 'take' ? 'Take' : 'Cut';
}

async function send(ctx: C, id: string, cmd: Command, who: string): Promise<boolean> {
  if (!rt) return false;
  const sw = rt.switchers.get(id);
  if (!sw) return false;
  if (!cfg(ctx).allowControls) {
    await ctx.notify('This module only reads. Turn on Allow controls in Setup to send commands.', 'warning');
    return false;
  }
  if (rt.busy) return false;
  rt.busy = true;
  try {
    const done = await sw.send(cmd, cfg(ctx).transitionMs);
    await ctx.log('info', `${sw.view.name}: ${done} (${who})`);
    if (cmd.action === 'preset' && cmd.target === 'pgm') await ctx.notify(`${sw.view.name}: ${done}`);
    return true;
  } catch (e) {
    await ctx.notify(e instanceof CommandError ? e.message : `Not sent: ${(e as Error).message}`, 'error');
    return false;
  } finally {
    if (rt) rt.busy = false;
    await draw(ctx);
  }
}

/** A preset key or tile: to preview at once; to program on a second press within CONFIRM_MS. */
async function pressPreset(ctx: C, index: number, p: PresetView): Promise<void> {
  if (!rt) return;
  const sw = currentSwitcher(ctx);
  if (!sw?.view.reachable) return;
  if (!cfg(ctx).allowControls) {
    disarm();
    await ctx.notify('This module only reads. Turn on Allow controls in Setup to send commands.', 'warning');
    return;
  }
  const cmd: Command = { action: 'preset', guid: p.guid, target: target(ctx) };
  if (cmd.target === 'pvw') {
    disarm();
    await send(ctx, sw.view.id, cmd, 'the panel keys');
    return;
  }
  const a = rt.armed;
  if (a && a.key === index && a.sw === sw.view.id && JSON.stringify(a.cmd) === JSON.stringify(cmd)) {
    disarm();
    await send(ctx, sw.view.id, cmd, 'the panel keys');
    return;
  }
  disarm();
  const r = rt;
  r.armed = {
    key: index,
    sw: sw.view.id,
    cmd,
    what: describe(cmd, sw.view),
    timer: setTimeout(() => {
      if (rt !== r || r.armed?.key !== index) return;
      r.armed = null;
      quiet(draw(ctx));
    }, CONFIRM_MS)
  };
  await draw(ctx); // the key and the screen say "press again"; nothing is sent yet
}

function commandOf(m: any): Command | null {
  if (m?.action === 'take' || m?.action === 'cut') return { action: m.action };
  if (m?.action === 'preset' && typeof m.guid === 'string' && (m.target === 'pvw' || m.target === 'pgm')) return { action: 'preset', guid: m.guid, target: m.target };
  return null;
}

export default defineModule<State, Config>({
  // The panel UI fills a taller screen too (1824×1080 on a 16:9 one). Controllers before 0.22.0 ignore it.
  fullPanel: true,
  // Every key of a larger deck: more presets per page. Older controllers ignore this and send 15 keys.
  fullDeck: true,

  // The deck changed size: an armed key may have moved and the pages changed.
  async deck(ctx) {
    if (!rt) return;
    disarm();
    rt.presetPage = 0;
    await ctx.keys.clear();
    await draw(ctx);
  },

  async start(ctx) {
    if (rt) for (const s of rt.switchers.values()) s.stop();
    rt?.video.stop();
    rt = { switchers: new Map(), view: 'presets', presetPage: 0, armed: null, busy: false, drawTimer: null, video: new VideoHub((m, id) => ctx.ui.send(m, id)) };
    await ctx.state.init({ sw: '', target: 'pvw' });
    await ctx.strip.set([
      { id: 'presets', label: 'Presets', icon: 'assets/presets.svg' },
      { id: 'outputs', label: 'Outputs', icon: 'assets/outputs.svg' },
      { id: 'inputs', label: 'Inputs', icon: 'assets/inputs.svg' },
      { id: 'setup', label: 'Setup', icon: 'assets/setup.svg' }
    ]);
    sync(ctx); // reads only: nothing is sent on start, whatever the reason
    const first = cfg(ctx).switchers[0];
    if (!rt.switchers.has(ctx.state.value.sw) && first) await ctx.state.patch({ sw: first.id });
    await reportStatus(ctx);
    await draw(ctx);
  },

  stop() {
    if (!rt) return;
    if (rt.drawTimer) clearTimeout(rt.drawTimer);
    disarm();
    for (const s of rt.switchers.values()) s.stop();
    rt.video.stop();
    rt = null;
  },

  async key(ctx, { index, action }) {
    if (action !== 'down' || !rt) return;
    const L = layout(grid(ctx));
    if (L.presets.includes(index)) {
      const n = currentSwitcher(ctx)?.view.presets.length ?? 0;
      const { pages } = presetPaging(n, L.presets.length);
      if (index === L.presets.at(-1) && pages > 1) {
        disarm();
        rt.presetPage = (rt.presetPage + 1) % pages;
        return draw(ctx);
      }
      const p = presetOnKey(ctx, index);
      if (p) await pressPreset(ctx, index, p);
      return;
    }
    if (index === L.target) return setTarget(ctx, target(ctx) === 'pvw' ? 'pgm' : 'pvw');
    if (index === L.switcher) {
      const list = views();
      if (list.length < 2) return;
      const i = list.findIndex((s) => s.id === currentSwitcher(ctx)?.view.id);
      return selectSwitcher(ctx, list[(i + 1) % list.length]!.id);
    }
    if (index === L.pvw) return setView(ctx, 'outputs');
    if (index === L.take || index === L.cut) {
      disarm();
      const sw = currentSwitcher(ctx);
      if (sw?.view.reachable) await send(ctx, sw.view.id, { action: index === L.take ? 'take' : 'cut' }, 'the panel keys');
    }
  },

  async strip(ctx, id) {
    await setView(ctx, id);
  },

  async client(ctx, { clientId, action }) {
    if (action === 'connect') await draw(ctx, clientId);
    if (action === 'disconnect') rt?.video.drop(clientId);
  },

  async ui(ctx, { clientId, message: m }) {
    if (!rt || typeof m !== 'object' || m === null) return;
    switch (m.type) {
      case 'hello':
        return draw(ctx, clientId);
      case 'view':
        return setView(ctx, m.view);
      case 'select':
        return selectSwitcher(ctx, m.id);
      case 'target':
        return setTarget(ctx, m.target);
      case 'page': {
        const n = currentSwitcher(ctx)?.view.presets.length ?? 0;
        const { pages } = presetPaging(n, layout(grid(ctx)).presets.length);
        rt.presetPage = Math.max(0, Math.min(pages - 1, Number(m.page) || 0));
        disarm();
        return draw(ctx);
      }
      case 'press-preset': {
        // A panel tile: the same rules as a key (to program needs a second tap).
        const p = currentSwitcher(ctx)?.view.presets.find((x) => x.guid === m.guid);
        if (p) await pressPreset(ctx, 100 + (currentSwitcher(ctx)?.view.presets.indexOf(p) ?? 0), p);
        return;
      }
      case 'control': {
        // Take and Cut buttons, and the web view after its own confirmation dialog.
        const cmd = commandOf(m);
        const id = typeof m.id === 'string' ? m.id : currentSwitcher(ctx)?.view.id;
        if (!cmd || !id) return;
        disarm();
        await send(ctx, id, cmd, m.from === 'web' ? 'the web view' : 'the panel');
        return;
      }
      case 'add':
        return addSwitcher(ctx, m);
      case 'edit':
        return editSwitcher(ctx, m);
      case 'remove':
        return removeSwitcher(ctx, m.id);
      case 'allow':
        return setAllow(ctx, m.on);
      case 'transition':
        return setTransition(ctx, m.ms);
      case 'video':
        return watch(ctx, clientId, m);
      case 'video-setting':
        await ctx.setConfig({ ...cfg(ctx), video: m.on === true });
        // Off: every stream stops now rather than when its viewers next ask.
        if (m.on !== true) {
          rt.video.stop();
          rt.video = new VideoHub((x, id) => ctx.ui.send(x, id));
        }
        return draw(ctx);
      case 'reconnect':
        for (const s of rt.switchers.values()) void s.poll();
        return;
    }
  }
});
