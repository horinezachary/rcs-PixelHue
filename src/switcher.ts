// One PixelHue switcher: polls it and keeps what it last said, in memory only. Commands go out only through
// send(), which the module calls on a confirmed operator action.

import { EventEmitter } from 'node:events';
import { MODELS, Q8Client, Q8Error } from './q8/client.js';
import { cutBody, echoOf, inputsOf, presetApplyBody, presetsOf, screensOf, takeBody, type EchoStream, type InputView, type PresetView, type ScreenView } from './q8/model.js';

export interface SwitcherEntry {
  id: string;
  host: string;
  /** Discovery (ucenter) port. 0: 19998. */
  port: number;
  /** Name to show instead of the one the switcher reports. */
  label: string;
}

export interface SwitcherView {
  id: string;
  host: string;
  name: string;
  model: string;
  serial: string;
  reachable: boolean;
  /** True once a full reading has arrived. */
  read: boolean;
  lastError: string;
  lastSeen: number;
  screens: ScreenView[];
  presets: PresetView[];
  inputs: InputView[];
  /** The switcher's input preview streams, where it has them. */
  echo: EchoStream[];
}

export type Command =
  | { action: 'preset'; guid: string; target: 'pvw' | 'pgm' }
  | { action: 'take' }
  | { action: 'cut' };

export class CommandError extends Error {}

/** Interfaces (inputs and their signal) change rarely and are the largest reply: read them every this many polls. */
const INTERFACE_EVERY = 5;

export class Switcher extends EventEmitter {
  readonly client: Q8Client;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;
  private count = 0;
  private rawInterfaces: unknown = null;
  private echo: EchoStream[] = [];
  private sinceLastOk = 0;
  view: SwitcherView;

  constructor(
    readonly entry: SwitcherEntry,
    private readonly pollMs: number,
    timeoutMs: number
  ) {
    super();
    this.client = new Q8Client(entry.host, entry.port || undefined, timeoutMs);
    this.view = { id: entry.id, host: entry.host, name: entry.label || entry.host, model: '', serial: '', reachable: false, read: false, lastError: '', lastSeen: 0, screens: [], presets: [], inputs: [], echo: [] };
  }

  start(): void {
    this.stopped = false;
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Reads everything now (and again on schedule). Reads only. */
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    if (this.timer) clearTimeout(this.timer);
    try {
      const c = this.client;
      const fresh = !c.session || this.rawInterfaces === null;
      const wantInterfaces = fresh || this.count % INTERFACE_EVERY === 0;
      const [screens, layers, presets, interfaces] = await Promise.all([
        c.get('screen/list-detail'),
        c.get('layers/list-detail'),
        c.get('preset'),
        wantInterfaces ? c.get('interface/list-detail') : Promise.resolve(this.rawInterfaces)
      ]);
      if (this.stopped) return;
      this.rawInterfaces = interfaces;
      // The preview stream layout changes only when someone rearranges it, so read it with the interfaces.
      // Not every model has it: leave it empty then.
      if (wantInterfaces) this.echo = await c.get('layers/echo').then(echoOf, () => []);
      this.count++;
      this.sinceLastOk = 0;
      const inputs = inputsOf(interfaces);
      const d = c.session?.device;
      const next: SwitcherView = {
        ...this.view,
        name: this.entry.label || d?.deviceName || (d ? `PixelHue ${MODELS[d.modelId] ?? ''}`.trim() : this.entry.host),
        model: d ? (d.SN?.startsWith('virtual') ? 'PixelFlow virtual device' : (MODELS[d.modelId] ?? `Model ${d.modelId}`)) : '',
        serial: c.session?.serial ?? '',
        reachable: true,
        read: true,
        lastError: '',
        lastSeen: Date.now(),
        screens: screensOf(screens, layers, interfaces, inputs),
        presets: presetsOf(presets),
        inputs,
        echo: this.echo
      };
      const changed = JSON.stringify({ ...next, lastSeen: 0 }) !== JSON.stringify({ ...this.view, lastSeen: 0 });
      this.view = next;
      if (changed) this.emit('change');
    } catch (e) {
      if (this.stopped) return;
      this.sinceLastOk++;
      const msg = (e as Error).message;
      // One missed reply is often a busy switcher: say so only after two.
      if (this.sinceLastOk >= 2 || !this.view.read) {
        const was = this.view.reachable || this.view.lastError !== msg;
        this.view = { ...this.view, reachable: false, lastError: msg };
        if (was) this.emit('change');
      }
    } finally {
      this.polling = false;
      if (!this.stopped) this.timer = setTimeout(() => void this.poll(), this.pollMs);
    }
  }

  /** The screens Take and Cut act on: those selected on the switcher, else those of the presets on PVW. */
  takeScreens(): ScreenView[] {
    const main = this.view.screens.filter((s) => s.kind !== 'mvr');
    const selected = main.filter((s) => s.selected);
    if (selected.length) return selected;
    const guids = new Set(this.view.presets.filter((p) => p.region === 'pvw' || p.region === 'both').flatMap((p) => p.screens));
    return main.filter((s) => guids.has(s.guid));
  }

  /** Sends one command, then reads the switcher again. Only for an operator's confirmed action. */
  async send(cmd: Command, transitionMs: number): Promise<string> {
    if (!this.view.reachable) throw new CommandError(`${this.view.name} is not answering`);
    const c = this.client;
    let done: string;
    try {
      if (cmd.action === 'preset') {
        const p = this.view.presets.find((x) => x.guid === cmd.guid);
        if (!p) throw new CommandError('That preset is no longer on the switcher');
        await c.post('preset/apply', presetApplyBody(p, cmd.target, transitionMs));
        done = `${p.name} loaded to ${cmd.target === 'pgm' ? 'program' : 'preview'}`;
      } else {
        const screens = this.takeScreens();
        if (!screens.length) throw new CommandError('No screen is selected on the switcher, and no preset is on preview');
        if (cmd.action === 'take') await c.put('screen/take', takeBody(screens, transitionMs));
        else await c.put('screen/cut', cutBody(screens));
        done = `${cmd.action === 'take' ? 'Take' : 'Cut'} on ${screens.map((s) => s.name).join(', ')}`;
      }
    } catch (e) {
      if (e instanceof CommandError) throw e;
      throw new CommandError(`Not sent: ${e instanceof Q8Error ? e.message : (e as Error).message}`);
    }
    // Read back so the tally shows what the switcher now says, not what was asked for.
    await this.poll();
    setTimeout(() => void this.poll(), Math.min(1500, (transitionMs || 500) + 200)).unref?.();
    return done;
  }
}
