// Turns what a PixelHue switcher reports into what the screens show, and builds the command bodies.
// Field meanings are from the PixelFlow OpenAPI manual V2.0.1 and PixelHue's Companion module.

/** screenIdObj.type: 2 main screen, 4 AUX, 8 multiviewer (MVR). Others (16, 32) are not shown. */
export type ScreenKind = 'main' | 'aux' | 'mvr';
const SCREEN_KIND: Record<number, ScreenKind> = { 2: 'main', 4: 'aux', 8: 'mvr' };

/** source.general.sourceType */
export const SOURCE_TYPE: Record<number, string> = {
  0: 'Empty',
  1: 'No source',
  2: 'Input',
  3: 'PGM',
  4: 'PVW',
  5: 'Background image',
  6: 'Logo',
  7: 'IP camera',
  8: 'Cropped input',
  9: 'Mosaic',
  10: 'IP camera mosaic',
  11: 'Internal source',
  12: 'Internal shape',
  13: 'USB drive',
  14: 'Image OSD',
  15: 'Text OSD',
  16: 'Audio meter',
  17: 'Stream',
  18: 'Recording',
  19: 'Clean feed'
};

/** layerIdObj.type */
const LAYER_KIND: Record<number, string> = { 2: 'layer', 4: 'aux', 8: 'window', 16: 'background', 32: 'logo', 256: 'layer' };

/** Raw input link state (LinkStateE), as pixelhue-studio reads it. 3 and 4 still have a picture. */
const SIGNAL: Record<number, [string, Signal]> = {
  0: ['No signal', 'off'],
  1: ['Live', 'live'],
  2: ['Live · over capacity', 'warning'],
  3: ['Live · unstable', 'warning'],
  4: ['Live · nonstandard', 'warning'],
  5: ['No signal · nonstandard', 'off'],
  6: ['No signal · over capacity', 'off'],
  7: ['Live · backup', 'live'],
  8: ['No signal · backup', 'off']
};
export type Signal = 'live' | 'warning' | 'off';

export interface LayerView {
  id: number;
  name: string;
  kind: string;
  /** What the layer shows: the input's name, or the kind of source. */
  source: string;
  sourceType: number;
  /** The input's interfaceId when the source is an input. */
  inputId: number | null;
  /** On a multiviewer tile showing a screen (sourceType 3 PGM, 4 PVW): that screen's id. */
  screenRef: number | null;
  signal: Signal | null;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export interface ScreenView {
  id: number;
  guid: string;
  kind: ScreenKind;
  name: string;
  width: number;
  height: number;
  /** Selected on the switcher: Take and Cut act on these. */
  selected: boolean;
  freeze: boolean;
  ftb: boolean;
  /** Names of the physical output connectors that carry this screen. */
  outputs: string[];
  pgm: LayerView[];
  pvw: LayerView[];
}

export type Region = 'pgm' | 'pvw' | 'both' | '';

export interface PresetView {
  guid: string;
  serial: number;
  name: string;
  /** Where the switcher says this preset is loaded now. */
  region: Region;
  /** Screen guids the preset holds. */
  screens: string[];
}

export interface InputView {
  id: number;
  name: string;
  signal: Signal;
  signalText: string;
  format: string;
  /** Screen names showing this input on PGM. */
  onPgm: string[];
  onPvw: string[];
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const list = (r: any): any[] => (Array.isArray(r?.data?.list) ? r.data.list : Array.isArray(r?.data) ? r.data : []);

/** Preset currentRegion: 2 on PGM, 4 on PVW, 6 (or 8) on both. Anything else: not loaded. */
export function regionOf(v: unknown): Region {
  const n = num(v);
  if (n === 6 || n === 8) return 'both';
  if (n === 2) return 'pgm';
  if (n === 4) return 'pvw';
  return '';
}

export function inputsOf(rawInterfaces: unknown): InputView[] {
  return list(rawInterfaces)
    .filter((i) => i?.auxiliaryInfo?.connectorInfo?.interfaceType === 2 && i.auxiliaryInfo.connectorInfo.workMode !== 2)
    .map((i) => {
      const [signalText, signal] = i.auxiliaryInfo?.online === 0 ? (['Card offline', 'off'] as [string, Signal]) : (SIGNAL[num(i.state, -1)] ?? (['Signal unknown', 'off'] as [string, Signal]));
      const t = i.actualTiming;
      const w = num(t?.horizontal?.addTime);
      const h = num(t?.vertical?.addTime);
      const format = signal !== 'off' && w && h ? `${w}×${h}${t.interlaced === 1 ? 'i' : 'p'}${num(t.refresh) ? Math.round(num(t.refresh) * 100) / 100 : ''}` : '';
      return { id: num(i.interfaceId), name: str(i.general?.name) || `Input ${i.interfaceId}`, signal, signalText, format, onPgm: [], onPvw: [] };
    });
}

/** Names of every connector by interfaceId, inputs and outputs alike. */
function connectorNames(rawInterfaces: unknown): Map<number, string> {
  return new Map(list(rawInterfaces).map((i) => [num(i.interfaceId), str(i.general?.name) || `Connector ${i.interfaceId}`]));
}

export function screensOf(rawScreens: unknown, rawLayers: unknown, rawInterfaces: unknown, inputs: InputView[]): ScreenView[] {
  const names = connectorNames(rawInterfaces);
  const inputById = new Map(inputs.map((i) => [i.id, i]));
  const screens: ScreenView[] = [];
  const origin = new Map<number, { x: number; y: number }>();
  for (const s of list(rawScreens)) {
    const kind = SCREEN_KIND[num(s?.screenIdObj?.type)];
    if (!kind || (!str(s.guid) && kind !== 'mvr')) continue;
    if (kind === 'main' && s.enable === 0) continue; // a deleted screen leaves a disabled placeholder
    const name = str(s.general?.name) || str(s.name);
    if (!name) continue;
    const win = s.mosaic?.window;
    origin.set(num(s.screenId), { x: num(win?.x), y: num(win?.y) });
    screens.push({
      id: num(s.screenId),
      guid: str(s.guid),
      kind,
      name,
      width: num(win?.width) || num(s.timing?.horizontal?.addTime) || 1920,
      height: num(win?.height) || num(s.timing?.vertical?.addTime) || 1080,
      selected: s.select === 1,
      freeze: s.freeze === 1,
      ftb: s.ftb?.enable === 1,
      outputs: (Array.isArray(s.mosaic?.outputs) ? s.mosaic.outputs : []).map((o: any) => str(o?.name) || names.get(num(o?.interfaceId)) || `Output ${o?.interfaceId}`),
      pgm: [],
      pvw: []
    });
  }
  const byId = new Map(screens.map((s) => [s.id, s]));
  for (const l of list(rawLayers)) {
    const o = l?.layerIdObj;
    const screen = byId.get(num(o?.attachScreenId));
    const kind = LAYER_KIND[num(o?.type)];
    if (!screen || !kind || l.enable === 0) continue;
    const g = l.source?.general ?? {};
    const sourceType = num(g.sourceType, 1);
    const inputId = sourceType === 2 || sourceType === 8 ? num(g.sourceId) : null;
    const input = inputId !== null ? inputById.get(inputId) : undefined;
    const at = origin.get(screen.id) ?? { x: 0, y: 0 };
    // A multiviewer tile can show a screen's PGM (3) or PVW (4); sourceId is then that screen's id and
    // sourceName only the screen's name, so say which.
    const screenRef = sourceType === 3 || sourceType === 4 ? num(g.sourceId) : null;
    const name = str(g.sourceName) || (screenRef !== null ? byId.get(screenRef)?.name ?? '' : '');
    const view: LayerView = {
      id: num(l.layerId),
      name: str(l.general?.name) || `Layer ${l.serial ?? l.layerId}`,
      kind,
      source: screenRef !== null ? `${SOURCE_TYPE[sourceType]} · ${name || 'Screen ' + screenRef}` : name || input?.name || SOURCE_TYPE[sourceType] || 'Source',
      sourceType,
      inputId,
      screenRef,
      signal: input?.signal ?? null,
      x: num(l.window?.x) - at.x,
      y: num(l.window?.y) - at.y,
      w: num(l.window?.width),
      h: num(l.window?.height),
      z: num(l.zorder)
    };
    // sceneType: 2 PGM, 4 PVW, 8 both. MVR windows report 2.
    const scene = num(o?.sceneType, 2);
    if (scene === 2 || scene === 8 || screen.kind === 'mvr') screen.pgm.push(view);
    if ((scene === 4 || scene === 8) && screen.kind !== 'mvr') screen.pvw.push({ ...view });
  }
  for (const s of screens) {
    s.pgm.sort((a, b) => a.z - b.z);
    s.pvw.sort((a, b) => a.z - b.z);
    for (const l of s.pgm) if (l.inputId !== null && s.kind !== 'mvr') inputById.get(l.inputId)?.onPgm.push(s.name);
    for (const l of s.pvw) if (l.inputId !== null) inputById.get(l.inputId)?.onPvw.push(s.name);
  }
  for (const i of inputs) {
    i.onPgm = [...new Set(i.onPgm)];
    i.onPvw = [...new Set(i.onPvw)];
  }
  return screens;
}

export function presetsOf(rawPresets: unknown): PresetView[] {
  return list(rawPresets)
    .filter((p) => str(p?.guid) && str(p?.name))
    .map((p) => ({
      guid: str(p.guid),
      serial: num(p.serial),
      name: str(p.name),
      region: regionOf(p.currentRegion),
      screens: (Array.isArray(p.screens) ? p.screens : []).map((s: any) => str(s?.guid)).filter(Boolean)
    }))
    .sort((a, b) => a.serial - b.serial);
}

// ---- command bodies --------------------------------------------------------------------------

export const TARGET = { pvw: 4, pgm: 2 } as const;

/** POST preset/apply, as PixelHue's Companion module sends it. */
export function presetApplyBody(p: { guid: string; serial: number }, target: 'pvw' | 'pgm', transitionMs: number) {
  return {
    auxiliary: { keyFrame: { enable: 1 }, switchEffect: { type: 1, time: transitionMs || 500 }, swapEnable: 1, effect: { enable: 1 } },
    serial: p.serial,
    targetRegion: TARGET[target],
    presetId: p.guid
  };
}

/** PUT screen/take: PVW to PGM on these screens. transitionMs 0 uses the switcher's own transition. */
export function takeBody(screens: ScreenView[], transitionMs: number) {
  return screens.map((s) => ({
    direction: 0,
    effectSelect: transitionMs ? 1 : 0,
    screenGuid: s.guid,
    screenId: s.id,
    screenName: s.name,
    swapEnable: 1,
    switchEffect: { type: 1, time: transitionMs || 500 }
  }));
}

/** PUT screen/cut: PVW to PGM at once on these screens. */
export function cutBody(screens: ScreenView[]) {
  return screens.map((s) => ({ direction: 0, screenId: s.id, swapEnable: 1 }));
}
