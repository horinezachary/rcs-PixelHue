// The input preview relay's pieces: reading the switcher's FLV, repackaging it as fragmented MP4, and the
// stream layout from layers/echo.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { echoOf } from '../src/q8/model.js';
import { FlvReader, type AvcFrame } from '../src/video/flv.js';
import { fragment, initSegment, mimeOf } from '../src/video/fmp4.js';

const flv = readFileSync(new URL('../sim/echo.flv', import.meta.url));

function read(chunk: number) {
  const configs: Buffer[] = [];
  const frames: AvcFrame[] = [];
  const r = new FlvReader((c) => configs.push(c.avcC), (f) => frames.push(f));
  for (let i = 0; i < flv.length; i += chunk) r.push(flv.subarray(i, i + chunk));
  return { configs, frames };
}

/** Top-level MP4 boxes: [type, size]. */
function boxes(b: Buffer): [string, number][] {
  const out: [string, number][] = [];
  for (let at = 0; at < b.length; ) {
    const size = b.readUInt32BE(at);
    out.push([b.toString('latin1', at + 4, at + 8), size]);
    at += size;
  }
  return out;
}

describe('the preview stream', () => {
  it('reads every frame of the switcher-style FLV however the bytes arrive', () => {
    for (const chunk of [1, 333, 7000, flv.length]) {
      const { configs, frames } = read(chunk);
      expect(configs).toHaveLength(1);
      expect(frames).toHaveLength(50); // 10 s at 5 fps
      expect(frames.filter((f) => f.key)).toHaveLength(5); // a keyframe every 12 frames, as a Q8's every 2.4 s
      expect(frames[0]!.key).toBe(true);
      expect(frames[1]!.dts - frames[0]!.dts).toBe(200);
    }
  });

  it('makes an init segment and one fragment per frame that Media Source Extensions take', () => {
    const { configs, frames } = read(4096);
    const avcC = configs[0]!;
    expect(mimeOf(avcC)).toMatch(/^video\/mp4; codecs="avc1\.42[0-9a-f]{4}"$/); // Baseline
    const init = initSegment(avcC, 1280, 720);
    expect(boxes(init).map(([t]) => t)).toEqual(['ftyp', 'moov']);
    expect(init.includes(Buffer.concat([Buffer.from('avcC', 'latin1'), avcC]))).toBe(true);
    const f = fragment(7, frames[0]!, 200);
    const [[moof, moofSize], [mdat, mdatSize]] = boxes(f) as [[string, number], [string, number]];
    expect([moof, mdat]).toEqual(['moof', 'mdat']);
    expect(mdatSize).toBe(frames[0]!.data.length + 8);
    // trun's data offset points at the frame inside mdat.
    const trun = f.indexOf('trun', 0, 'latin1');
    expect(f.readUInt32BE(trun + 12)).toBe(moofSize + 8);
    expect(f.subarray(moofSize + 8).equals(frames[0]!.data)).toBe(true);
  });

  it('reads the stream layout as a real Q8 reports it', () => {
    // Trimmed from a real Q8's layers/echo: tiles run down the columns, sourceId is the input's interfaceId.
    const tile = (x: number, y: number, id: number, type = 2) => ({
      window: { width: 960, height: 540, x, y },
      source: { sourceType: type, sourceId: id, relationId: 0, osd: { componentId: '', componentType: 0 }, ipcLayout: [], cropInfo: { needCrop: 0, windows: null } },
      type: 0,
      screenIndex: 0
    });
    const raw = {
      code: 0,
      message: 'ok',
      data: [
        { index: 0, type: 2, url: '/flv1', frame: 20, width: 3840, height: 2160, urlType: 0, echoLayout: [tile(0, 0, 95), tile(0, 540, 96), tile(960, 0, 3, 3)] },
        { index: 1, type: 2, url: '/flv2', frame: 20, width: 3840, height: 2160, urlType: 0, echoLayout: [tile(0, 0, 67)] },
        { index: 2, type: 2, url: '/flv3', frame: 20, width: 3840, height: 2160, urlType: 0, echoLayout: [] },
        { index: 3, type: 2, url: 'rtsp://elsewhere/x', width: 3840, height: 2160, echoLayout: [tile(0, 0, 1)] }
      ]
    };
    expect(echoOf(raw)).toEqual([
      { index: 0, path: '/flv1', width: 3840, height: 2160, tiles: [{ inputId: 95, x: 0, y: 0, w: 960, h: 540 }, { inputId: 96, x: 0, y: 540, w: 960, h: 540 }] },
      { index: 1, path: '/flv2', width: 3840, height: 2160, tiles: [{ inputId: 67, x: 0, y: 0, w: 960, h: 540 }] }
    ]);
    expect(echoOf({ code: 0, data: {} })).toEqual([]);
  });

  it('ships the same player to the panel and the web view', () => {
    expect(readFileSync(new URL('../web/video.js', import.meta.url), 'utf8')).toBe(readFileSync(new URL('../ui/video.js', import.meta.url), 'utf8'));
  });
});
