#!/usr/bin/env node
// Development tool: runs the gathering popup reader over a local screen recording and prints every
// extraction it found, to tune gather-reader.js against new cases. Recordings stay on your machine.
//
//   node tools/read-recording.js <video> [--box x,y,w,h] [--ffmpeg path] [--fps 10] [--trace]
//
// --box is the popup's box in the video's pixels (default 770,805,380,110). ffmpeg comes from --ffmpeg,
// the FFMPEG environment variable, or PATH.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const R = require(path.join(__dirname, '..', 'gather-reader.js'));

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const video = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--box' && args[args.indexOf(a) - 1] !== '--ffmpeg' && args[args.indexOf(a) - 1] !== '--fps');
if (!video) { console.error('usage: node tools/read-recording.js <video> [--box x,y,w,h] [--ffmpeg path] [--fps 10] [--trace]'); process.exit(1); }
const [bx, by, bw, bh] = (opt('--box') || '770,805,380,110').split(',').map(Number);
const ffmpeg = opt('--ffmpeg') || process.env.FFMPEG || 'ffmpeg';
const fps = +(opt('--fps') || 10), trace = args.includes('--trace');
const W = R.REF_W, H = R.REF_H, SIZE = W * H * 3;

const tr = R.tracker();
const p = spawn(ffmpeg, ['-v', 'error', '-i', video, '-vf', `fps=${fps},crop=${bw}:${bh}:${bx}:${by},scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
let buf = Buffer.alloc(0), i = 0;
p.stdout.on('data', d => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= SIZE) {
    const t = i / fps, r = R.read({ w: W, h: H, ch: 3, data: buf.subarray(0, SIZE) });
    if (trace) console.log(t.toFixed(1), r.present ? `s=${r.s.toFixed(2)} f=${r.f.toFixed(2)} ${r.grade || '?'}${r.orb ? ' orb' : ''}${r.sDone ? ' s-done' : ''}${r.fDone ? ' f-done' : ''}${r.gradeRgb ? ' title ' + r.gradeRgb.map(Math.round).join('/') : ''}` : '-');
    tr.feed(t, r);
    buf = Buffer.from(buf.subarray(SIZE)); i++;
  }
});
p.stderr.on('data', d => process.stderr.write(d));
p.on('close', () => {
  const res = tr.finish(i / fps), sum = R.summarize(res, i / fps);
  res.extractions.forEach((e, k) => console.log(`#${k + 1} node ${e.node} ${e.start.toFixed(1)}–${e.end.toFixed(1)}s ${e.result} ${e.grade || '?'}${e.tierUp ? ' (tier-up from ' + e.firstGrade + ')' : ''}${e.qty ? ' x' + e.qty : ''}`));
  console.log(JSON.stringify(sum));
});
