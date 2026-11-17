// Reads a real switcher once, through the module's own client and parsers, and prints what the module would show.
// Reads only: the client sends GETs (discovery, open-detail, list-detail, preset) and nothing else.
//   npx -y tsx scripts/read-check.ts <host> [out.json]
import { writeFileSync } from 'node:fs';
import { Switcher } from '../src/switcher.js';

const [host, out] = process.argv.slice(2);
if (!host) {
  console.error('usage: read-check <host> [out.json]');
  process.exit(2);
}
const sw = new Switcher({ id: 'check', host, port: 0, label: '' } as any, 1000, 8000);
await sw.poll();
sw.stop();
const v = sw.view;
if (out) writeFileSync(out, JSON.stringify(v, null, 2));
if (!v.read) {
  console.log(`Could not read ${host}: ${v.lastError}`);
  process.exit(1);
}
const warn: string[] = [];
console.log(`${v.name} · ${v.model} · SN ${v.serial}`);
console.log(`\n${v.inputs.length} inputs`);
for (const i of v.inputs) console.log(`  ${i.id} ${i.name} · ${i.signalText} · ${i.format || '-'}${i.onPgm.length ? ` · PGM ${i.onPgm.join(', ')}` : ''}${i.onPvw.length ? ` · PVW ${i.onPvw.join(', ')}` : ''}`);
console.log(`\n${v.screens.length} screens`);
for (const s of v.screens) {
  console.log(`  [${s.kind}] ${s.name} ${s.width}x${s.height}${s.selected ? ' selected' : ''} · outputs: ${s.outputs.join(', ') || '-'}`);
  if (!s.width || !s.height) warn.push(`${s.name}: no size`);
  for (const [r, ls] of [['PGM', s.pgm], ['PVW', s.pvw]] as const) {
    for (const l of ls) {
      console.log(`    ${r} ${l.name || '#' + l.id}: ${l.source} @ ${l.x},${l.y} ${l.w}x${l.h}`);
      if (!l.source) warn.push(`${s.name} ${r} layer ${l.id}: no source name`);
      if (l.w <= 0 || l.h <= 0) warn.push(`${s.name} ${r} layer ${l.id}: no size`);
      if (l.x + l.w < 0 || l.y + l.h < 0 || l.x > s.width || l.y > s.height) warn.push(`${s.name} ${r} layer ${l.id}: outside the screen`);
    }
  }
}
console.log(`\n${v.presets.length} presets`);
for (const p of v.presets) {
  console.log(`  ${p.serial} ${p.name} · ${p.region || '-'} · ${p.screens.length} screens`);
  if (!p.name) warn.push(`preset ${p.serial}: no name`);
  if (!p.screens.length) warn.push(`preset ${p.serial}: no screens`);
}
console.log(warn.length ? `\nWarnings:\n  ${warn.join('\n  ')}` : '\nNo warnings');
