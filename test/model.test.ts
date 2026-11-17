import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeToken } from '../src/q8/client.js';
import { inputsOf, presetsOf, regionOf, screensOf } from '../src/q8/model.js';

describe('token', () => {
  it('is an HS256 JWT of {"SN": serial} signed with the start time, as jsonwebtoken makes it', () => {
    const t = makeToken('2Z1234567', '1731800000000');
    const [h, b, s] = t.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(Buffer.from(b!, 'base64url').toString()).toBe('{"SN":"2Z1234567"}');
    expect(s).toBe(createHmac('sha256', '1731800000000').update(`${h}.${b}`).digest('base64url'));
    // Known value from jsonwebtoken.sign({ SN: 'abc' }, '123', { algorithm: 'HS256', noTimestamp: true }).
    expect(makeToken('abc', 123)).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJTTiI6ImFiYyJ9.' + createHmac('sha256', '123').update('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJTTiI6ImFiYyJ9').digest('base64url'));
  });
});

describe('reading the switcher', () => {
  it('reads preset regions', () => {
    expect([0, 2, 4, 6, 8, undefined].map(regionOf)).toEqual(['', 'pgm', 'pvw', 'both', 'both', '']);
    const p = presetsOf({ data: { list: [{ guid: 'b', name: 'Two', serial: 2, currentRegion: 4 }, { guid: 'a', name: 'One', serial: 1 }, { guid: '', name: 'Blank' }, { guid: 'c', name: ' ' }] } });
    expect(p.map((x) => [x.name, x.region])).toEqual([['One', ''], ['Two', 'pvw']]);
  });

  it('keeps only real inputs, with the card offline and link states', () => {
    const inputs = inputsOf({
      data: {
        list: [
          { interfaceId: 1, general: { name: 'A' }, state: 3, actualTiming: { horizontal: { addTime: 1920 }, vertical: { addTime: 1080 }, refresh: 59.94, interlaced: 1 }, auxiliaryInfo: { connectorInfo: { interfaceType: 2, workMode: 0 } } },
          { interfaceId: 2, general: { name: 'B' }, state: 1, auxiliaryInfo: { online: 0, connectorInfo: { interfaceType: 2, workMode: 0 } } },
          { interfaceId: 3, general: { name: 'Spare' }, state: 1, auxiliaryInfo: { connectorInfo: { interfaceType: 2, workMode: 2 } } },
          { interfaceId: 4, general: { name: 'OUT' }, state: 1, auxiliaryInfo: { connectorInfo: { interfaceType: 3, workMode: 0 } } }
        ]
      }
    });
    expect(inputs.map((i) => [i.name, i.signal, i.signalText, i.format])).toEqual([
      ['A', 'warning', 'Live · unstable', '1920×1080i59.94'],
      ['B', 'off', 'Card offline', '']
    ]);
  });

  it('puts layers on PGM, PVW or both, and skips disabled screens and layers', () => {
    const screens = { data: { list: [
      { screenId: 1, guid: 'g1', screenIdObj: { type: 2 }, general: { name: 'Main' }, enable: 1, mosaic: { window: { x: 1000, y: 0, width: 1920, height: 1080 }, outputs: [{ interfaceId: 9 }] } },
      { screenId: 2, guid: 'g2', screenIdObj: { type: 2 }, general: { name: 'Gone' }, enable: 0 },
      { screenId: 3, guid: '', screenIdObj: { type: 8 }, general: { name: 'MVR 1' }, timing: { horizontal: { addTime: 1920 }, vertical: { addTime: 1080 } } }
    ] } };
    const layers = { data: { list: [
      { layerId: 1, layerIdObj: { type: 2, attachScreenId: 1, sceneType: 8 }, source: { general: { sourceType: 2, sourceId: 5 } }, window: { x: 1100, y: 10, width: 100, height: 50 }, zorder: 1 },
      { layerId: 2, layerIdObj: { type: 2, attachScreenId: 1, sceneType: 4 }, source: { general: { sourceType: 5, sourceName: '' } }, window: { x: 1000, y: 0, width: 1920, height: 1080 }, zorder: 0 },
      { layerId: 3, layerIdObj: { type: 2, attachScreenId: 1, sceneType: 2 }, enable: 0, source: { general: { sourceType: 2, sourceId: 5 } } },
      { layerId: 4, layerIdObj: { type: 8, attachScreenId: 3, sceneType: 2 }, source: { general: { sourceType: 3, sourceId: 1, sourceName: 'Main' } }, window: { x: 0, y: 0, width: 960, height: 540 } },
      { layerId: 5, layerIdObj: { type: 8, attachScreenId: 3, sceneType: 2 }, source: { general: { sourceType: 4, sourceId: 1 } }, window: { x: 960, y: 0, width: 960, height: 540 } }
    ] } };
    const ifs = { data: { list: [{ interfaceId: 5, general: { name: 'Cam' }, state: 1, auxiliaryInfo: { connectorInfo: { interfaceType: 2 } } }, { interfaceId: 9, general: { name: 'OUT 1' }, auxiliaryInfo: { connectorInfo: { interfaceType: 3 } } }] } };
    const inputs = inputsOf(ifs);
    const s = screensOf(screens, layers, ifs, inputs);
    expect(s.map((x) => x.name)).toEqual(['Main', 'MVR 1']);
    expect(s[0]!.outputs).toEqual(['OUT 1']);
    expect(s[0]!.pgm.map((l) => [l.source, l.x, l.y])).toEqual([['Cam', 100, 10]]);
    expect(s[0]!.pvw.map((l) => l.source)).toEqual(['Background image', 'Cam']);
    // A real Q8 names only the screen on a multiviewer tile of a screen's PGM or PVW.
    expect(s[1]!.pgm.map((l) => [l.source, l.kind, l.screenRef])).toEqual([['PGM · Main', 'window', 1], ['PVW · Main', 'window', 1]]);
    expect(inputs[0]).toMatchObject({ onPgm: ['Main'], onPvw: ['Main'] });
  });
});
