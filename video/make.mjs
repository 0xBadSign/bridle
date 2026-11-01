// One command: capture every scene, then render every cut and voiceover.md.
// usage: node video/make.mjs [--no-send] [--dry-send] [--scene id,id]   (flags are passed to capture.mjs)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
for (const script of ['capture.mjs', 'render.mjs']) {
  const extra = script === 'capture.mjs' ? process.argv.slice(2) : [];
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...extra], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
