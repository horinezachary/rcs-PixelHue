// The module against the simulated Q8 and the SDK's fake controller: the source-of-truth rules (start,
// restore and reconnect only read; commands only on an operator action with Allow controls on), the
// keys, preview and take, and what is shown on each screen.
import { startTestModule, type TestModule } from '@rcs/module-sdk/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mod, { KEY, type Config, type State } from '../src/index.js';
import { Q8Simulator } from '../src/sim/q8.js';

let sim: TestModule<State, Config> | null = null;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(() => {
  process.env.RCS_PIXELHUE_POLL_MS = '100';
});

afterEach(async () => {
  await sim?.close();
  sim = null;
  while (cleanups.length) await cleanups.pop()!();
});

async function until(check: () => boolean, ms = 5000, what = ''): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error(`timed out ${what}: ${JSON.stringify(last()?.switchers)} ${sim?.errors.map(String)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const last = () => (sim ? [...sim.uiMessages].reverse().find((m) => m.message?.type === 'snapshot')?.message : null);

async function q8(name = 'Q8 Main', serial = 'Q8SIM0001') {
  const q = new Q8Simulator({ name, serial });
  const ports = await q.listen();
  cleanups.push(() => q.close());
  return { q, port: ports.discovery, api: ports.api };
}

const entry = (id: string, port: number) => ({ id, host: '127.0.0.1', port, label: '' });

async function start(switchers: Config['switchers'], extra: { allow?: boolean; state?: State; reason?: 'boot' | 'restore' | 'user'; transitionMs?: number } = {}) {
  const config: Config = { switchers, allowControls: extra.allow ?? false, transitionMs: extra.transitionMs ?? 0 };
  sim = await startTestModule(mod, { config, state: extra.state, reason: extra.reason });
  await sim.settle();
  await until(() => last()?.switchers?.length === switchers.length && last().switchers.every((s: any) => s.read && s.reachable), 5000, 'for the switchers');
  await sim.settle();
  return sim;
}

const presetNamed = (name: string) => last().switcher.presets.find((p: any) => p.name === name);
const screenNamed = (name: string) => last().switcher.screens.find((s: any) => s.name === name);

describe('the switcher is the source of truth', () => {
  it.each(['boot', 'restore', 'user'] as const)('only reads on a %s start, whatever the save says', async (reason) => {
    const { q, port } = await q8();
    await start([entry('00000001', port)], { allow: true, reason, state: { sw: '00000001', target: 'pgm' } });
    await new Promise((r) => setTimeout(r, 400)); // a few polls
    expect(q.writes).toEqual([]);
    const s = last();
    expect(s.switchers[0]).toMatchObject({ name: 'Q8 Main', model: 'Q8', serial: 'Q8SIM0001', reachable: true });
    expect(s.target).toBe('pgm');
    // Nothing read from the switcher goes into state or config.
    expect(Object.keys(sim!.state).sort()).toEqual(['sw', 'target']);
    expect(JSON.stringify(sim!.config)).not.toMatch(/Q8 Main|Keynote|LED Wall|Cam 1/);
    expect(sim!.secrets).toEqual({});
  });

  it('reconnect only reads, and a restarted switcher is picked up with a new token', async () => {
    const { q, port, api } = await q8();
    await start([entry('00000001', port)], { allow: true });
    await fetch(`http://127.0.0.1:${api}/sim/restart`);
    await sim!.sendUi({ type: 'reconnect' });
    await until(() => q.unauthorized > 0, 3000, 'for the old token to be refused');
    const before = q.unauthorized;
    await new Promise((r) => setTimeout(r, 500));
    expect(q.unauthorized - before).toBeLessThanOrEqual(1);
    expect(last().switchers[0].reachable).toBe(true);
    expect(q.writes).toEqual([]);
  });

  it('shows a switcher that does not answer, and sends nothing', async () => {
    const { port } = await q8();
    const gone = await q8('Gone', 'X');
    await gone.q.close();
    const config: Config = { switchers: [entry('00000001', port), entry('00000002', gone.port)], allowControls: true, transitionMs: 0 };
    sim = await startTestModule(mod, { config });
    await until(() => last()?.switchers?.[1]?.lastError === 'Connection refused', 4000, 'for the error');
    expect(last().switchers[1].reachable).toBe(false);
  });
});

describe('what is on each output', () => {
  it('lists every screen with its program and preview sources, outputs and the multiviewer', async () => {
    const { port } = await q8();
    await start([entry('00000001', port)]);
    const wall = screenNamed('LED Wall');
    expect(wall).toMatchObject({ kind: 'main', width: 3840, height: 1080, outputs: ['OUT 1-1', 'OUT 1-2', 'OUT 1-3', 'OUT 1-4'] });
    expect(wall.pgm.map((l: any) => l.source)).toEqual(['Playback A']);
    expect(wall.pvw.map((l: any) => l.source)).toEqual(['Playback A', 'Lectern Laptop']);
    // Layer windows are given relative to the screen, not the switcher's global canvas.
    const left = screenNamed('IMAG Left');
    expect(left.pgm[0]).toMatchObject({ source: 'Playback A', x: 0, y: 0, w: 1920, h: 1080 });
    expect(screenNamed('Confidence')).toMatchObject({ kind: 'aux', outputs: ['OUT 2-3'] });
    const mvr = screenNamed('MVR 1');
    expect(mvr.kind).toBe('mvr');
    expect(mvr.pgm.map((l: any) => l.source).slice(8, 10)).toEqual(['PGM', 'PVW']);
    expect(mvr.pvw).toEqual([]);
    // Unnamed placeholder screens are left out.
    expect(last().switcher.screens).toHaveLength(5);
  });

  it('lists inputs with their signal and where they are used', async () => {
    const { port, api } = await q8();
    await start([entry('00000001', port)]);
    const inputs = last().switcher.inputs;
    expect(inputs).toHaveLength(12);
    expect(inputs[0]).toMatchObject({ name: 'Cam 1 Wide', signal: 'live', format: '1920×1080p60', onPgm: [], onPvw: ['IMAG Left'] });
    expect(inputs[3]).toMatchObject({ name: 'Cam 4 Jib', signal: 'off', format: '' });
    expect(inputs[4].onPgm).toEqual(['LED Wall', 'IMAG Left', 'IMAG Right']);
    await fetch(`http://127.0.0.1:${api}/sim/signal?input=5&state=0`);
    await until(() => last().switcher.inputs[4].signal === 'off', 3000, 'for the signal to drop');
    expect(screenNamed('LED Wall').pgm[0].signal).toBe('off');
  });

  it('shows preset tally from the switcher', async () => {
    const { port } = await q8();
    await start([entry('00000001', port)]);
    expect(presetNamed('Walk In').region).toBe('pgm');
    expect(presetNamed('Keynote').region).toBe('pvw');
    expect(presetNamed('Panel').region).toBe('');
    expect(sim!.keys[0]).toMatchObject({ label: 'WALK IN', sublabel: 'PGM', background: '#8A1C1C' });
    expect(sim!.keys[1]).toMatchObject({ label: 'KEYNOTE', sublabel: 'PVW', background: '#12602E' });
    expect(sim!.keys[KEY.PVW]).toMatchObject({ label: 'PREVIEW', sublabel: 'KEYNOTE' });
  });
});

describe('recall, preview and take', () => {
  it('sends nothing with Allow controls off', async () => {
    const { q, port } = await q8();
    await start([entry('00000001', port)]);
    await sim!.press(3);
    await sim!.press(KEY.TAKE);
    await sim!.press(KEY.CUT);
    await sim!.sendUi({ type: 'control', action: 'take' });
    await sim!.sendUi({ type: 'control', action: 'preset', guid: presetNamed('Panel').guid, target: 'pgm', from: 'web' });
    expect(q.writes).toEqual([]);
    expect(sim!.keys[KEY.TAKE]).toMatchObject({ label: 'VIEW ONLY' });
    expect(sim!.notifications.at(-1)?.text).toMatch(/only reads/);
  });

  it('a preset key loads to preview at once, and TAKE puts it on program', async () => {
    const { q, port } = await q8();
    await start([entry('00000001', port)], { allow: true });
    await sim!.press(3); // Panel
    expect(q.writes).toHaveLength(1);
    expect(q.writes[0]).toMatchObject({ path: 'POST preset/apply', body: { targetRegion: 4, presetId: presetNamed('Panel').guid, serial: 4 } });
    await until(() => presetNamed('Panel').region === 'pvw', 2000, 'for the tally');
    expect(presetNamed('Keynote').region).toBe('');
    expect(screenNamed('LED Wall').pvw.map((l: any) => l.source)).toEqual(['Playback B', 'Cam 1 Wide', 'Cam 2 Tight', 'Cam 3 Handheld']);
    expect(last().takeScreens).toEqual(['LED Wall', 'IMAG Left', 'IMAG Right']);
    await sim!.press(KEY.TAKE);
    expect(q.writes[1]).toMatchObject({ path: 'PUT screen/take' });
    expect((q.writes[1]!.body as any[]).map((b) => b.screenName)).toEqual(['LED Wall', 'IMAG Left', 'IMAG Right']);
    expect((q.writes[1]!.body as any[])[0]).toMatchObject({ direction: 0, effectSelect: 0, swapEnable: 1 });
    await until(() => presetNamed('Panel').region === 'pgm', 2000, 'for the take');
    expect(presetNamed('Walk In').region).toBe('pvw'); // swapped back to preview
    expect(screenNamed('LED Wall').pgm.map((l: any) => l.source)[0]).toBe('Playback B');
    expect(sim!.keys[3]).toMatchObject({ sublabel: 'PGM' });
  });

  it('CUT sends a cut on the same screens, with the transition time when one is set', async () => {
    const { q, port } = await q8();
    await start([entry('00000001', port)], { allow: true, transitionMs: 1200 });
    await sim!.press(6); // IMAG Only: two screens
    await until(() => presetNamed('IMAG Only').region === 'pvw', 2000, 'for the tally');
    expect(q.writes[0]!.body).toMatchObject({ auxiliary: { switchEffect: { type: 1, time: 1200 } } });
    await sim!.press(KEY.CUT);
    expect(q.writes[1]).toMatchObject({ path: 'PUT screen/cut', body: [{ screenId: 2, direction: 0, swapEnable: 1 }, { screenId: 3, direction: 0, swapEnable: 1 }] });
    await sim!.sendUi({ type: 'control', action: 'take' });
    expect((q.writes[2]!.body as any[])[0]).toMatchObject({ effectSelect: 1, switchEffect: { type: 1, time: 1200 } });
  });

  it('loading straight to program needs a second press within 3 seconds', async () => {
    const { q, port } = await q8();
    await start([entry('00000001', port)], { allow: true });
    await sim!.press(KEY.TARGET);
    expect(sim!.state.target).toBe('pgm');
    expect(sim!.keys[KEY.TARGET]).toMatchObject({ label: 'LOAD TO', sublabel: 'PROGRAM' });
    expect(q.writes).toEqual([]); // the setting is the module's own
    await sim!.press(4); // Video Roll: armed
    expect(q.writes).toEqual([]);
    expect(sim!.keys[4]).toMatchObject({ sublabel: 'PRESS AGAIN' });
    expect(last().armed.what).toBe('Load Video Roll to PROGRAM');
    await sim!.press(5); // a different preset re-arms, sends nothing
    expect(q.writes).toEqual([]);
    await sim!.press(5);
    expect(q.writes).toHaveLength(1);
    expect(q.writes[0]!.body).toMatchObject({ targetRegion: 2, serial: 6 });
    await until(() => presetNamed('Q&A').region === 'pgm', 2000, 'for the tally');
  });

  it('a panel tile follows the same rules, and the web view sends after its own dialog', async () => {
    const { q, port } = await q8();
    await start([entry('00000001', port)], { allow: true, state: { sw: '', target: 'pgm' } });
    await sim!.sendUi({ type: 'press-preset', guid: presetNamed('Break').guid });
    expect(q.writes).toEqual([]);
    await sim!.sendUi({ type: 'press-preset', guid: presetNamed('Break').guid });
    expect(q.writes[0]!.body).toMatchObject({ targetRegion: 2, serial: 9 });
    await sim!.sendUi({ type: 'control', action: 'preset', guid: presetNamed('Walk Out').guid, target: 'pvw', from: 'web' });
    expect(q.writes[1]!.body).toMatchObject({ targetRegion: 4, serial: 10 });
    expect(sim!.logs.at(-1)?.text).toMatch(/Walk Out loaded to preview \(the web view\)/);
  });

  it('takes the screens selected on the switcher', async () => {
    const { q, port, api } = await q8();
    await start([entry('00000001', port)], { allow: true });
    await sim!.press(7); // Confidence: AUX only
    await until(() => last().takeScreens.join() === 'Confidence', 2000, 'for the selection');
    await fetch(`http://127.0.0.1:${api}/sim/select?screen=1&on=1`);
    await until(() => last().takeScreens.length === 2, 2000, 'for the front panel selection');
    await sim!.press(KEY.TAKE);
    expect((q.writes[1]!.body as any[]).map((b) => b.screenId)).toEqual([1, 4]);
  });

  it('pages through more than ten presets and cycles switchers', async () => {
    const a = await q8('Q8 Main', 'A1');
    const b = await q8('Q8 Backup', 'B2');
    await start([entry('00000001', a.port), entry('00000002', b.port)], { allow: true });
    expect(sim!.keys[9]).toMatchObject({ label: 'MORE ▶', sublabel: '1 of 2' });
    await sim!.press(9);
    expect(sim!.keys[0]).toMatchObject({ label: 'WALK OUT' });
    expect(sim!.keys[KEY.SWITCHER]).toMatchObject({ label: 'Q8 MAIN', sublabel: '1 of 2 ▶' });
    await sim!.press(KEY.SWITCHER);
    expect(sim!.state.sw).toBe('00000002');
    expect(last().switcher.name).toBe('Q8 Backup');
    expect(a.q.writes).toEqual([]);
    expect(b.q.writes).toEqual([]);
  });
});

describe('setup', () => {
  it('adds, renames and removes switchers in config only', async () => {
    const { q, port } = await q8();
    sim = await startTestModule(mod, { config: { switchers: [], allowControls: false, transitionMs: 0 } });
    await sim.settle();
    expect(sim.status).toMatchObject({ connection: 'disconnected', text: 'Add a switcher in Setup' });
    await sim.sendUi({ type: 'add', host: '127.0.0.1', port });
    await until(() => last()?.switchers?.[0]?.reachable === true, 3000, 'for the new switcher');
    const id = sim.config.switchers[0]!.id;
    expect(sim.state.sw).toBe(id);
    await sim.sendUi({ type: 'add', host: 'not an address!' });
    expect(sim.notifications.at(-1)?.text).toMatch(/not an IP/);
    await sim.sendUi({ type: 'edit', id, label: 'Main Q8' });
    await until(() => last().switchers[0].name === 'Main Q8', 2000, 'for the label');
    await sim.sendUi({ type: 'transition', ms: 20000 });
    expect(sim.config.transitionMs).toBe(0);
    await sim.sendUi({ type: 'transition', ms: 800 });
    expect(sim.config.transitionMs).toBe(800);
    await sim.sendUi({ type: 'remove', id });
    expect(sim.config.switchers).toEqual([]);
    expect(sim.state.sw).toBe('');
    expect(q.writes).toEqual([]);
  });
});
