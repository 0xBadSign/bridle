# Demo video pipeline

Turns the dashboard into finished MP4s with burned-in captions. No npm dependencies, nothing downloaded.

```
node video/make.mjs            # capture every scene, render every cut, write video/voiceover.md
node video/make.mjs --no-send  # same, but reuse the cached arena frames (no testnet transaction)
```

Requirements: Node 22, Google Chrome (`C:/Program Files/Google/Chrome/Application/chrome.exe`, override with `CHROME_PATH`), ffmpeg and ffprobe on PATH (or `FFMPEG_BIN` / `FFMPEG_DIR`). Internet access: the dashboard reads NEAR testnet and Base Sepolia live.

## What it does

- `capture.mjs` starts a static server for the repository root (port 8781), launches headless Chrome with the DevTools Protocol (port 9331, page rendered at 1280x720 CSS px with device scale 1.5, so frames are 1920x1080), plays each scene from `shots.json` and writes frames plus `timeline.json` to `video/work/<scene>/`. Waits are for real selectors and live data; the waiting time is not recorded.
- `render.mjs` slices the timelines into the cuts of `shots.json`, writes an ASS caption file per cut and runs ffmpeg (1920x1080, 30 fps, H.264, yuv420p, no audio). It also writes `voiceover.md`.
- Output: `video/out/bridle-2m15.mp4`, `video/out/bridle-45s.mp4`. `video/out/` and `video/work/` are gitignored.

## Editing

`shots.json` has `scenes` (what to capture) and `cuts` (which slice of which scene, with which caption). Scene steps: `hold`, `scroll`, `type`, `click`, `mark` / `unmark` (red highlight ring), `hash`, `select`, `waitFor`, `sleep`, `eval`. A scene with `card` renders a title card from `card.mjs`. Captions are a string or a list of `{ at, text, pos }` (seconds into the entry; `pos: "top"` moves the caption up).

Recapture only some scenes: `node video/capture.mjs --scene xray,keys`, then `node video/render.mjs`.

## The arena scene sends a real transaction

The `arena-hook` scene types the example prompt injection and presses "Send to the agent". That sends one real NEAR testnet transaction with the published play-money arena key, and the vault refuses it (`not_allowed`). It never sends an in-mandate request (accepted requests lock the shared arena for minutes). Use `--dry-send` to type without sending, or `--no-send` to skip the scene and keep its cached frames.

## After the UI freeze (2026-11-08)

Run `node video/make.mjs`, then check the stills (`ffmpeg -ss 60 -i video/out/bridle-2m15.mp4 -frames:v 1 still.png`). The proof card in `shots.json` says "87/87 claims verified" (from `make verify`); update it if the claim count changes. The open demo proposal on the X-ray page is staged with `scripts/stage-proposal.mjs` and expires after the DAO's 7-day proposal period; if it is gone, stage a new one or drop the `xray` entries from the cuts.
