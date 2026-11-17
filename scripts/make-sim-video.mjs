// Makes sim/echo.flv: the simulator's input preview stream, laid out as a Q8 lays out its own (inputs in a
// 4x4 grid running down the columns), 10 s at 5 fps, H.264 Baseline with a keyframe every 12 frames, no audio.
// Needs ffmpeg with libx264 and a font. Run once; the file is committed.
//   node scripts/make-sim-video.mjs
import { execFileSync } from 'node:child_process';

const W = 1280, H = 720, TW = W / 4, TH = H / 4;
const inputs = [
  ['Cam 1 Wide', '0x3E63DD'], ['Cam 2 Tight', '0x8E4EC6'], ['Cam 3 Handheld', '0x12A594'], ['Cam 4 Jib', null],
  ['Playback A', '0xF76B15'], ['Playback B', '0x0090FF'], ['Lectern Laptop', '0x46A758'], ['Presenter Notes', '0xE54666'],
  ['Graphics Fill', '0xAB4ABA'], ['Graphics Key', '0xFFC53D'], ['Spare HDMI', null], ['Spare DP', null]
];
const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const f = [];
inputs.forEach(([name, color], i) => {
  const x = Math.floor(i / 4) * TW, y = (i % 4) * TH;
  if (!color) return; // no signal: black, as the switcher shows it
  f.push(`drawbox=x=${x}:y=${y}:w=${TW}:h=${TH}:color=${color}@0.85:t=fill`);
  // something that moves, so a still picture is easy to tell from a live one
  f.push(`drawbox=x='${x}+mod(t*${40 + i * 7}\\,${TW - 30})':y=${y + TH - 34}:w=30:h=20:color=white@0.9:t=fill`);
  f.push(`drawtext=fontfile=${font}:text='${name}':x=${x}+12:y=${y}+12:fontsize=24:fontcolor=white`);
  f.push(`drawtext=fontfile=${font}:text='IN ${i + 1}  %{pts\\:hms}':x=${x}+12:y=${y}+48:fontsize=16:fontcolor=white@0.85`);
});
execFileSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=5:d=10`,
  '-vf', f.join(','),
  '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-g', '12', '-bf', '0', '-b:v', '300k', '-an',
  '-f', 'flv', 'sim/echo.flv'
], { stdio: 'inherit' });
console.log('Wrote sim/echo.flv');
