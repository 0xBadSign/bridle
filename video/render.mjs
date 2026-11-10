// Turn the captured scene timelines (video/work) into finished MP4s with burned-in captions, and write
// video/voiceover.md from the same caption lines.
//
// usage: node video/render.mjs [--cut id,id]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(HERE, 'work');
const OUT = path.join(HERE, 'out');
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'shots.json'), 'utf8'));
const args = process.argv.slice(2);
const only = args.includes('--cut') ? args[args.indexOf('--cut') + 1].split(',') : null;
// --voice: stretch caption windows to the spoken lines in work/tts/durations.json (written by voice.mjs).
const VOICE = args.includes('--voice') ? JSON.parse(fs.readFileSync(path.join(WORK, 'tts', 'durations.json'), 'utf8')) : null;
const VOICE_LEAD = 0.15; // voice.mjs starts each clip this long after its caption
const VOICE_TAIL = 0.45; // silence after a line before the next caption
const FPS = 30;

function tool(name) {
  for (const cand of [process.env.FFMPEG_DIR ? path.join(process.env.FFMPEG_DIR, name) : null, name === 'ffmpeg' ? process.env.FFMPEG_BIN : null, name].filter(Boolean)) {
    if (spawnSync(cand, ['-version'], { stdio: 'ignore' }).status === 0) return cand;
  }
  throw new Error(`${name} not found (put it on PATH, or set FFMPEG_BIN or FFMPEG_DIR)`);
}
const FFMPEG = tool('ffmpeg');
const FFPROBE = tool('ffprobe');

fs.mkdirSync(OUT, { recursive: true });
const timelines = {};
const loadScene = (id) => (timelines[id] ??= JSON.parse(fs.readFileSync(path.join(WORK, id, 'timeline.json'), 'utf8')));

/** The part of a scene's timeline between `from` and `to` seconds, as [{file, dur}]. */
function slice(id, from = 0, to = Infinity) {
  const { total, timeline } = loadScene(id);
  const end = Math.min(to, total);
  if (to !== Infinity && to > total + 1e-6) console.log(`  note: ${id} to=${to} is past its captured length ${total.toFixed(2)}; clamped`);
  const out = [];
  let t = 0;
  for (const seg of timeline) {
    const a = Math.max(t, from);
    const b = Math.min(t + seg.dur, end);
    if (b - a > 1e-4) out.push({ file: `${id}/${seg.file}`, dur: b - a });
    t += seg.dur;
  }
  return out;
}

const ts = (s) => { const cs = Math.round(s * 100); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, '0')}`;

function wrap(text, width = 60) {
  width = Math.ceil(text.length / Math.ceil(text.length / width)) + 4; // balance the lines
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > width) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines.join('\\N');
}

const ASS_HEAD = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Segoe UI Semibold,46,&H00FFFFFF,&H00FFFFFF,&H0C100D0B,&H00000000,0,0,0,0,100,100,0,0,3,18,0,2,160,160,64,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

function renderCut(id, cut) {
  console.log('rendering', id);
  const list = [];
  const caps = [];
  let t = 0;
  for (const e of cut.entries) {
    const segs = slice(e.scene, e.from, e.to);
    const dur = segs.reduce((a, s) => a + s.dur, 0);
    if (dur <= 0) throw new Error(`empty entry ${e.scene} in ${id}`);
    const lines = typeof e.caption === 'string' ? [{ at: 0, text: e.caption }] : e.caption || [];
    if (!VOICE || !lines.length) {
      for (const s of segs) list.push(s);
      lines.forEach((l, i) => {
        const start = t + l.at;
        const end = i + 1 < lines.length ? t + lines[i + 1].at : t + dur;
        caps.push({ start, end: end - 0.04, text: l.text, pos: l.pos });
      });
      t += dur;
      continue;
    }
    // Voiced: each caption window lasts at least as long as its spoken line; the window's last
    // frame is held for the extra time.
    const base = e.from ?? 0;
    const bounds = [...lines.map((l) => l.at), dur];
    if (bounds[0] > 0) for (const s of slice(e.scene, base, base + bounds[0])) { list.push(s); t += s.dur; }
    lines.forEach((l, i) => {
      const win = slice(e.scene, base + bounds[i], base + bounds[i + 1]);
      const w = win.reduce((a, s) => a + s.dur, 0);
      for (const s of win) list.push(s);
      const spoken = VOICE[l.text];
      if (spoken === undefined) console.log(`  note: no voice clip for "${l.text.slice(0, 50)}"`);
      const need = spoken === undefined ? 0 : spoken + VOICE_LEAD + VOICE_TAIL;
      const hold = Math.max(0, need - w);
      if (hold > 0) list.push({ file: (win.at(-1) ?? list.at(-1)).file, dur: hold });
      caps.push({ start: t, end: t + w + hold - 0.04, text: l.text, pos: l.pos });
      t += w + hold;
    });
  }
  const total = t;
  const listFile = path.join(WORK, `${id}.concat.txt`);
  const body = list.map((s) => `file '${s.file}'\nduration ${s.dur.toFixed(5)}`).join('\n');
  fs.writeFileSync(listFile, `${body}\nfile '${list[list.length - 1].file}'\n`);
  const ass = ASS_HEAD + caps.map((c) => `Dialogue: 0,${ts(c.start)},${ts(c.end)},Cap,,0,0,${c.pos === 'top' ? 50 : 0},,{${c.pos === 'top' ? '\\an8' : ''}\\fad(180,180)}${wrap(c.text)}`).join('\n') + '\n';
  fs.writeFileSync(path.join(WORK, `${id}.ass`), ass);
  fs.writeFileSync(path.join(WORK, `${id}.captions.json`), JSON.stringify({ caps, total }));
  const outFile = path.join(OUT, cut.out);
  const vf = `fps=${FPS},subtitles=${id}.ass,fade=t=in:d=0.4,fade=t=out:st=${(total - 0.6).toFixed(2)}:d=0.6,format=yuv420p`;
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', `${id}.concat.txt`, '-vf', vf, '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-r', String(FPS), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', outFile], { cwd: WORK, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed for ' + id);
  const p = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height,r_frame_rate,pix_fmt,codec_name:format=duration', '-of', 'default=nw=1', outFile], { encoding: 'utf8' });
  console.log(p.stdout.replace(/\n/g, ' '));
  return { id, cut, caps, total };
}

const results = [];
for (const [id, cut] of Object.entries(cfg.cuts)) {
  if (only && !only.includes(id)) continue;
  results.push(renderCut(id, cut));
}

// voiceover.md: written from all cuts that exist in shots.json (even if --cut limited the render, re-read them all)
if (!only) {
  let md = `# Voice-over script\n\nGenerated by \`video/render.mjs\` from \`video/shots.json\`. The burned-in captions are exactly these lines. Start times are seconds into each cut (m:ss). Pace guide: about 2.5 words per second; lines flagged "fast" need more than 3.\n`;
  for (const r of results) {
    md += `\n## ${r.cut.title} (${r.cut.out}, ${mmss(r.total)})\n\n| Start | Line | Words |\n|---|---|---|\n`;
    for (const c of r.caps) {
      const words = c.text.split(/\s+/).length;
      const fast = words / (c.end - c.start) > 3 ? ' (fast)' : '';
      md += `| ${mmss(c.start)} | ${c.text.replace(/\|/g, '/')} | ${words}${fast} |\n`;
    }
    md += `\nFull text:\n\n${r.caps.map((c) => c.text).join(' ')}\n`;
  }
  fs.writeFileSync(path.join(HERE, 'voiceover.md'), md);
  console.log('wrote voiceover.md');
}
