// Voice-over: speaks every caption line of each rendered cut with a text-to-speech model and lays the
// clips under the video at the caption start times. Reads video/work/<cut>.captions.json (written by
// render.mjs) and writes video/out/<name>-voice.mp4 next to the silent cut. It first speaks every line,
// then re-renders the cuts with `render.mjs --voice` so each caption lasts as long as its spoken line.
//
// usage: node video/voice.mjs [--cut id,id] [--voice name] [--no-render]
// Key: GROQ_API_KEY, else .private/groq.key. Model: TTS_MODEL (default canopylabs/orpheus-v1-english).
// Clips are cached in video/work/tts/ by text and voice, so re-running only speaks changed lines.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const WORK = path.join(HERE, 'work');
const OUT = path.join(HERE, 'out');
const TTS = path.join(WORK, 'tts');
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'shots.json'), 'utf8'));
const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const only = opt('--cut')?.split(',');
const VOICE = opt('--voice') || process.env.TTS_VOICE || 'troy';
const MODEL = process.env.TTS_MODEL || 'canopylabs/orpheus-v1-english';
const BASE = (process.env.TTS_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const keyFile = path.join(ROOT, '.private', 'groq.key');
const KEY = process.env.GROQ_API_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '');
if (!KEY) throw new Error('set GROQ_API_KEY or put the key in .private/groq.key');
const MAX_TEMPO = 1.2; // speed a clip up at most this much to fit its caption

const FFMPEG = process.env.FFMPEG_BIN || (process.env.FFMPEG_DIR ? path.join(process.env.FFMPEG_DIR, 'ffmpeg') : 'ffmpeg');
const FFPROBE = process.env.FFPROBE_BIN || (process.env.FFMPEG_DIR ? path.join(process.env.FFMPEG_DIR, 'ffprobe') : 'ffprobe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const duration = (f) => Number(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim());

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The caption as it should be read aloud: identifiers and dates in words, colons as pauses. */
const spoken = (t) => t
  .replace(/\b(\d{4})-(\d\d)-(\d\d)\b/g, (_, y, m, d) => `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`)
  .replace(/\b([a-z]+)_([a-z_]+)\b/g, (s) => s.replace(/_/g, ' '))
  .replace(/\bFastAuth\b/g, 'Fast Auth')
  .replace(/\bNEAR HACKATHON\b/g, 'NEAR Hackathon')
  .replace(/(\d)x\b/g, '$1 times')
  .replace(/:\s/g, '. ');

/** One spoken line as a wav file (cached). */
async function speak(text) {
  fs.mkdirSync(TTS, { recursive: true });
  const file = path.join(TTS, crypto.createHash('sha256').update(`${MODEL}|${VOICE}|${text}`).digest('hex').slice(0, 16) + '.wav');
  if (fs.existsSync(file)) return file;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${BASE}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, voice: VOICE, input: text, response_format: 'wav' }),
    });
    if (r.ok) {
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      return file;
    }
    const body = await r.text();
    if ((r.status === 429 || r.status >= 500) && attempt < 8) {
      const wait = Number(r.headers.get('retry-after')) * 1000 || 5000 * (attempt + 1);
      console.log(`  tts ${r.status}, retrying in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
      continue;
    }
    throw new Error(`tts failed (${r.status}): ${body.slice(0, 300)}`);
  }
}

const cuts = Object.entries(cfg.cuts).filter(([id]) => !only || only.includes(id));

// 1. Speak every caption line and record its length.
const durFile = path.join(TTS, 'durations.json');
const durations = fs.existsSync(durFile) ? JSON.parse(fs.readFileSync(durFile, 'utf8')) : {};
const clipOf = {};
for (const [, cut] of cuts) {
  for (const e of cut.entries) {
    const lines = typeof e.caption === 'string' ? [e.caption] : (e.caption || []).map((l) => l.text);
    for (const text of lines) {
      if (clipOf[text]) continue;
      clipOf[text] = await speak(spoken(text));
      durations[text] = duration(clipOf[text]);
    }
  }
}
fs.writeFileSync(durFile, JSON.stringify(durations, null, 1));

// 2. Re-render the cuts with each caption window stretched to its spoken line.
if (!args.includes('--no-render')) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'render.mjs'), '--voice', ...(only ? ['--cut', only.join(',')] : [])], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('render.mjs --voice failed');
}

// 3. Lay the clips under each cut.
for (const [id, cut] of cuts) {
  const capsFile = path.join(WORK, `${id}.captions.json`);
  const video = path.join(OUT, cut.out);
  if (!fs.existsSync(capsFile) || !fs.existsSync(video)) throw new Error(`render ${id} first (node video/render.mjs)`);
  const { caps, total } = JSON.parse(fs.readFileSync(capsFile, 'utf8'));
  console.log(`voicing ${id}: ${caps.length} lines, voice ${VOICE}`);
  const clips = [];
  let free = 0; // the time the previous clip ends
  for (const [i, c] of caps.entries()) {
    const file = await speak(spoken(c.text));
    const len = duration(file);
    const start = Math.max(c.start + 0.15, free);
    const slot = (i + 1 < caps.length ? caps[i + 1].start : total) - start - 0.1;
    let tempo = 1;
    if (len > slot) tempo = Math.min(MAX_TEMPO, len / Math.max(slot, 0.1));
    const said = len / tempo;
    if (said > slot + 0.05) console.log(`  note: line ${i + 1} runs ${(said - slot).toFixed(1)} s past its caption: "${c.text.slice(0, 60)}"`);
    clips.push({ file, start, tempo });
    free = start + said + 0.1;
  }
  if (free > total) console.log(`  note: the voice runs ${(free - total).toFixed(1)} s past the end of ${id}; it is cut there`);

  const inputs = clips.flatMap((c) => ['-i', c.file]);
  const chains = clips.map((c, i) => `[${i + 1}:a]aresample=48000,${c.tempo > 1 ? `atempo=${c.tempo.toFixed(3)},` : ''}adelay=${Math.round(c.start * 1000)}:all=1[a${i}]`);
  const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
  const outFile = path.join(OUT, cut.out.replace(/\.mp4$/, '-voice.mp4'));
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-i', video, ...inputs, '-filter_complex', [...chains, mix].join(';'), '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', total.toFixed(3), '-movflags', '+faststart', outFile], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed for ' + id);
  console.log(`  wrote ${path.relative(ROOT, outFile)} (${duration(outFile).toFixed(1)} s)`);
}
