// Starts a simulated PixelHue Q8 for development. Nothing here talks to real equipment.
//
//   npm run sim
//
// Then add 127.0.0.1 with port 19998 in Setup (a second switcher: RCS_PIXELHUE_SIM_COUNT=2 adds one on 19999).
// Development hooks: curl 'http://127.0.0.1:<api port>/sim/signal?input=1&state=0'  (see src/sim/q8.ts)
import { Q8Simulator } from './sim/q8.js';

const host = process.env.RCS_PIXELHUE_SIM_HOST ?? '127.0.0.1';
const count = Math.min(4, Math.max(1, Number(process.env.RCS_PIXELHUE_SIM_COUNT) || 1));
const sims: Q8Simulator[] = [];
for (let i = 0; i < count; i++) {
  const sim = new Q8Simulator({ name: i ? `Q8 Backup` : 'Q8 Main', serial: `Q8SIM000${i + 1}` });
  const ports = await sim.listen(19998 + i, 0, host);
  sims.push(sim);
  console.log(`PixelHue Q8 "${sim.name}"  discovery https://${host}:${ports.discovery}  API http://${host}:${ports.api}`);
}

const stop = async () => {
  await Promise.all(sims.map((s) => s.close()));
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
