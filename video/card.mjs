// HTML for title cards (proof, honesty, end card). Designed for a 1280x720 CSS viewport.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function cardHtml(c) {
  const accent = c.accent || '#3fc79a';
  const lines = (c.lines || []).map((l) => {
    const o = typeof l === 'string' ? { text: l } : l;
    return `<li class="${o.mark || ''}"><span class="m">${o.mark === 'no' ? '&#10005;' : o.mark === 'tick' ? '&#10003;' : '&bull;'}</span><span>${esc(o.text)}</span></li>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;background:#0f1512;color:#e6efe9;font:22px/1.45 "Segoe UI",system-ui,sans-serif}
body{display:flex;flex-direction:column;justify-content:center;padding:0 110px 120px;background:radial-gradient(1000px 500px at 80% 0,#17302a 0,#0f1512 70%)}
.k{color:${accent};font-weight:700;letter-spacing:.14em;text-transform:uppercase;font-size:18px;margin-bottom:14px}
h1{margin:0 0 6px;font-size:${c.big ? 40 : 46}px;line-height:1.15;letter-spacing:-.01em}
.big{font:700 ${c.bigSize || 92}px/1.1 Consolas,"Courier New",monospace;color:${accent};margin:18px 0 8px;word-break:break-word}
.sub{color:#98a8a0;font-size:22px;margin:0 0 18px}
ul{list-style:none;padding:0;margin:22px 0 0;display:grid;gap:12px}
li{display:flex;gap:14px;font-size:25px;align-items:flex-start}
li .m{color:${accent};font-weight:700;min-width:26px}
li.no .m{color:#ff8f86}
.code{font:20px/1.5 Consolas,"Courier New",monospace;background:#17201c;border:1px solid #28362f;border-radius:10px;padding:14px 18px;margin-top:18px;color:#cfe3d9;white-space:pre-wrap;word-break:break-all}
.f{position:absolute;left:110px;top:34px;color:#98a8a0;font-size:17px}
</style></head><body>
${c.kicker ? `<div class="k">${esc(c.kicker)}</div>` : ''}
<h1>${esc(c.title)}</h1>
${c.big ? `<div class="big">${esc(c.big)}</div>` : ''}
${c.sub ? `<p class="sub">${esc(c.sub)}</p>` : ''}
${lines ? `<ul>${lines}</ul>` : ''}
${c.code ? `<div class="code">${esc(c.code)}</div>` : ''}
${c.footer ? `<div class="f">${esc(c.footer)}</div>` : ''}
</body></html>`;
}
