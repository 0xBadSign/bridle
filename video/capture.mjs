// Capture every scene in shots.json into video/work/<scene>/ (PNG/JPEG frames + timeline.json).
// A timeline is a list of { file, dur } entries: a held still has a long dur, a smooth scroll or a typing
// animation has many short ones. render.mjs slices these timelines into the cuts.
//
// usage: node video/capture.mjs [--scene id,id] [--no-send] [--dry-send]
//   --scene     capture only these scenes (default: all)
//   --no-send   skip scenes marked "sends": true (they keep their cached frames)
//   --dry-send  run "sends" scenes but do not press the send button (typing only)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, startStatic, sleep } from './cdp.mjs';
import { cardHtml } from './card.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORK = path.join(HERE, 'work');
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'shots.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const only = args.includes('--scene') ? args[args.indexOf('--scene') + 1].split(',') : null;
const FPS = 30;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

const server = await startStatic(ROOT, cfg.port);
const browser = await Browser.launch({ port: cfg.chromePort, scale: cfg.scale || 1 });
const page = browser.page;
let failed = 0;

async function captureScene(scene) {
  const dir = path.join(WORK, scene.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const timeline = [];
  let n = 0;
  const frame = async (dur, jpeg = false) => {
    const file = `f${String(++n).padStart(5, '0')}.${jpeg ? 'jpg' : 'png'}`;
    await page.shot(path.join(dir, file), { jpeg });
    timeline.push({ file, dur });
  };

  if (scene.card) {
    await page.goto('about:blank');
    await page.eval(`document.open(); document.write(${JSON.stringify(cardHtml(scene.card))}); document.close();`);
    await sleep(600);
    await frame(scene.card.hold || 30);
  } else {
    await page.goto('about:blank');
    await page.goto(`http://127.0.0.1:${cfg.port}${scene.url}`);
    await page.waitFor(scene.ready || cfg.ready, 40000, 'ready of ' + scene.id);
    await sleep(scene.settleMs ?? 1200);
    let dry = false;
    for (const st of scene.steps || []) {
      if (dry && JSON.stringify(st).includes('#result')) continue;
      if (st.waitFor) await page.waitFor(st.waitFor, st.timeoutMs || 60000, st.waitFor);
      else if (st.sleep) await sleep(st.sleep);
      else if (st.eval) await page.eval(st.eval);
      else if (st.hold) { await sleep(150); await frame(st.hold); }
      else if (st.mark) await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(st.mark)}); if (!e) throw new Error('mark: no ' + ${JSON.stringify(st.mark)}); e.setAttribute('data-vmark', '1'); e.style.outline = '4px solid #ff5a4f'; e.style.outlineOffset = '5px'; e.style.borderRadius = '8px'; })()`);
      else if (st.unmark) await page.eval(`document.querySelectorAll('[data-vmark]').forEach((e) => { e.style.outline = ''; e.style.outlineOffset = ''; e.removeAttribute('data-vmark'); })`);
      else if (st.click) {
        if (st.click === '#go' && flag('dry-send')) { console.log('  (dry-send: not clicking)'); dry = true; continue; }
        await page.eval(`document.querySelector(${JSON.stringify(st.click)}).click()`);
      } else if (st.select) await page.eval(`(() => { const s = document.querySelector(${JSON.stringify(st.select.sel)}); s.value = ${JSON.stringify(st.select.value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      else if (st.hash) await page.eval(`location.hash = ${JSON.stringify(st.hash)}`);
      else if (st.scroll) {
        const { to, s = 2, offset = cfg.scrollOffset ?? 90, container } = st.scroll;
        const box = container ? `document.querySelector(${JSON.stringify(container)})` : 'window';
        const start = await page.eval(container ? `${box}.scrollTop` : 'window.scrollY');
        const target = typeof to === 'number' ? to : await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(to)}); if (!e) throw new Error('scroll: no ' + ${JSON.stringify(to)}); return e.getBoundingClientRect().top + window.scrollY - ${offset}; })()`);
        const frames = Math.max(1, Math.round(s * FPS));
        const maxTop = container ? await page.eval(`${box}.scrollHeight - ${box}.clientHeight`) : Infinity;
        const goal = Math.min(target, maxTop);
        for (let i = 1; i <= frames; i++) {
          await page.eval(`${box}.scrollTo(0, ${start + (goal - start) * ease(i / frames)})`);
          await frame(1 / FPS);
        }
      } else if (st.type) {
        const { sel, text, s = 3 } = st.type;
        const rate = 15;
        const frames = Math.max(1, Math.round(s * rate));
        await page.eval(`document.querySelector(${JSON.stringify(sel)}).focus()`);
        for (let i = 1; i <= frames; i++) {
          const upto = Math.round((text.length * i) / frames);
          await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(text)}.slice(0, ${upto}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
          await frame(1 / rate);
        }
      } else throw new Error('unknown step ' + JSON.stringify(st));
    }
    const txt = await page.eval('document.body.innerText');
    const bad = (cfg.badText || []).filter((b) => new RegExp(b, 'i').test(txt));
    if (bad.length) console.log(`  WARNING: ${scene.id} shows text matching: ${bad.join(', ')}`);
  }
  const total = timeline.reduce((a, t) => a + t.dur, 0);
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ total, timeline }, null, 1));
  console.log(`  ${scene.id}: ${n} frames, ${total.toFixed(1)} s`);
}

try {
  // Dashboards poll every 10 s and redraw; freeze long intervals so highlights and typed text stay put.
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'const _si = window.setInterval; window.setInterval = (f, t, ...a) => (t >= 9000 ? 0 : _si(f, t, ...a));' });
  for (const scene of cfg.scenes) {
    if (only && !only.includes(scene.id)) continue;
    if (scene.sends && flag('no-send')) { console.log(`  ${scene.id}: skipped (--no-send), cached frames kept`); continue; }
    console.log('capturing', scene.id);
    try { await captureScene(scene); } catch (e) { failed++; console.log(`  FAILED ${scene.id}: ${e.message}`); }
  }
  if (page.console.length) console.log('page exceptions:', page.console.slice(0, 5));
} finally {
  browser.close();
  server.close();
}
await sleep(1500);
process.exit(failed ? 1 : 0);
