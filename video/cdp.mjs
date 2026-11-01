// Minimal Chrome DevTools Protocol driver and static file server. No dependencies (Node 22: WebSocket, fetch).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml' };

/** Serve `root` read-only on 127.0.0.1:port. Never serves video/work or video/out. */
export function startStatic(root, port) {
  root = path.resolve(root);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.normalize(path.join(root, p));
    const blocked = [path.join(root, 'video'), path.join(root, 'node_modules'), path.join(root, '.git')];
    const bad = !file.startsWith(root + path.sep) || (blocked.some((b) => file.startsWith(b + path.sep)));
    if (bad) return void res.writeHead(403).end('forbidden');
    fs.readFile(file, (err, buf) => {
      if (err) return void res.writeHead(404).end('not found');
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export class Browser {
  static async launch({ port, width = 1920, height = 1080, scale = 1 }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-chrome-'));
    const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, `--window-size=${width},${height}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
    const b = new Browser(proc, dir, port, width, height);
    for (let i = 0; i < 80; i++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        const t = targets.find((x) => x.type === 'page');
        if (t) { b.page = await Page.connect(t.webSocketDebuggerUrl, width, height, scale); return b; }
      } catch {}
      await sleep(250);
    }
    b.close();
    throw new Error('Chrome did not start');
  }
  constructor(proc, dir, port, width, height) { Object.assign(this, { proc, dir, port, width, height }); }
  close() {
    try { this.page?.ws.close(); } catch {}
    try { this.proc.kill(); } catch {}
    if (process.platform === 'win32') { try { spawn('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    setTimeout(() => { try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch {} }, 1500);
  }
}

export class Page {
  static async connect(url, width, height, scale = 1) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    const p = new Page(ws);
    await p.send('Page.enable');
    await p.send('Runtime.enable');
    await p.send('Emulation.setDeviceMetricsOverride', { width: Math.round(width / scale), height: Math.round(height / scale), deviceScaleFactor: scale, mobile: false });
    return p;
  }
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.console = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) { const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
      else if (msg.method === 'Runtime.exceptionThrown') this.console.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async goto(url) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 120; i++) { await sleep(250); try { if ((await this.eval('document.readyState')) === 'complete') return; } catch {} }
    throw new Error('page load timeout: ' + url);
  }
  /** Wait until `fn` (JS expression string) is truthy. */
  async waitFor(expr, timeoutMs = 20000, label = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(`!!(${expr})`)) return true; } catch {} await sleep(250); }
    throw new Error(`timeout waiting for ${label}`);
  }
  async shot(file, { jpeg = false } = {}) {
    const r = await this.send('Page.captureScreenshot', jpeg ? { format: 'jpeg', quality: 94 } : { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
}
