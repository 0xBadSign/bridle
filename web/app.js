// Bridle dashboard: routing, polling, rendering. Plain ES modules, no build step.
import { mountArena } from "./arena.js";
import { createKeeper } from "./keeper-web.js";
import { baseRpc, fetchVault, VAULTS } from "./lib/chain.js";
import { ago, esc } from "./lib/fmt.js";
import * as pages from "./pages.js";

const $ = (id) => document.getElementById(id);
const PAGES = ["overview", "ops", "parked", "rejections", "arena", "how"];
const POLL_MS = 10000;

let vaultKey = "main";
try {
  const q = new URLSearchParams(location.search).get("vault") || localStorage.getItem("bridle-vault");
  if (q && VAULTS[q]) vaultKey = q;
} catch {}
const cache = {}; // vault key -> { data, wait, error }
let page = "overview";
let arenaUnsub = null;
let arenaMounted = false;

const keeper = createKeeper();

function route() {
  const h = location.hash.replace(/^#\/?/, "");
  page = PAGES.includes(h) ? h : "overview";
  document.querySelectorAll("#nav a").forEach((n) => n.classList.toggle("on", n.dataset.p === page));
  if (page !== "arena" && arenaUnsub) { arenaUnsub(); arenaUnsub = null; arenaMounted = false; }
  render();
  window.scrollTo(0, 0);
}

function render() {
  const el = $("page");
  const c = cache[vaultKey];
  $("vault-select").value = vaultKey;
  if (page === "arena") {
    if (!arenaMounted) { arenaUnsub = mountArena(el, keeper); arenaMounted = true; }
    renderBanner(c);
    return;
  }
  if (page === "how") { el.innerHTML = pages.how(); renderBanner(null); return; }
  if (!c || !c.data) {
    el.innerHTML = c && c.error ? `<p class="err">Could not read the vault: ${esc(c.error)}. Retrying every 10 s.</p>` : `<p class="muted">Reading ${esc(VAULTS[vaultKey].id)} from NEAR testnet...</p>`;
    renderBanner(null);
    return;
  }
  const d = c.data;
  el.innerHTML = { overview: () => pages.overview(d, vaultKey), ops: () => pages.ops(d, c.wait), parked: () => pages.parked(d), rejections: () => pages.rejections(d) }[page]();
  renderBanner(c);
}

function renderBanner(c) {
  const b = $("banner");
  const x = c && c.data ? pages.banner(c.data) : null;
  b.hidden = !x;
  if (x) { b.className = "banner " + x[0]; b.textContent = x[1]; }
}

/** For the active operation: which stage is it really waiting at? */
async function waitState(d) {
  const st = d.state;
  if (st.active === null || st.active === undefined) return null;
  const op = d.ops.find((o) => o.id === st.active);
  const slot = op && op.slots[op.cursor];
  if (!slot || slot.signing || slot.verifying?.length || !slot.main?.signed?.length) return null;
  try {
    const t = slot.main.signed[0].hash;
    const [rc, safe] = await Promise.all([baseRpc("eth_getTransactionReceipt", [t]), baseRpc("eth_getBlockByNumber", ["safe", false])]);
    if (!rc.result) return { stage: "broadcast" };
    const block = parseInt(rc.result.blockNumber, 16);
    const safeN = parseInt(safe.result.number, 16);
    if (block > safeN) return { stage: "safe", block, safe: safeN };
    return { stage: "settle" };
  } catch {
    return null;
  }
}

const polling = {};
async function poll(key = vaultKey) {
  if (polling[key]) return;
  polling[key] = true;
  try {
    const data = await fetchVault(VAULTS[key].id);
    const wait = await waitState(data);
    cache[key] = { data, wait };
  } catch (e) {
    cache[key] = { ...(cache[key] || {}), error: String(e.message || e) };
  } finally {
    polling[key] = false;
  }
  if (key === vaultKey) render();
  paintFoot();
}

function paintFoot() {
  const c = cache[vaultKey];
  $("poll-note").textContent = c && c.data ? `Live from NEAR testnet, updated ${ago(c.data.fetchedAt)}. Refreshes every 10 s.` : "Loading...";
  $("keeper-note").hidden = false;
  $("keeper-note").textContent = keeper.isWorking() ? "Your browser is acting as the keeper for the arena vault (an operation is in flight)." : "Your browser acts as the keeper for the arena vault whenever an operation needs one.";
}

$("vault-select").addEventListener("change", (e) => {
  vaultKey = e.target.value;
  try { localStorage.setItem("bridle-vault", vaultKey); } catch {}
  poll();
  render();
});
document.addEventListener("bridle-refresh", () => { poll("arena"); if (vaultKey !== "arena") poll(vaultKey); });
window.addEventListener("hashchange", route);

route();
poll();
setInterval(() => !document.hidden && poll(), POLL_MS);
setInterval(paintFoot, 5000);
keeper.start();
