// "Verify the proof yourself" in the browser: finds the NEAR transaction in which the vault received
// the MPC attestation for one step, then runs the same independent checks as
// `scripts/verify-attestation.mjs` (web/lib/attest.js) with WebCrypto and @noble/curves from a CDN.
import { baseRpc, view } from "./lib/chain.js";
import { esc } from "./lib/fmt.js";
import { findAttestation, verifyAttestation } from "./lib/attest.js";

const TX_API = "https://tx.test.fastnear.com";
const NOBLE = "https://cdn.jsdelivr.net/npm/@noble/curves@2.2.0/secp256k1.js/+esm";
const SIGNER = "v1.signer-prod.testnet";

async function post(path, body) {
  for (let i = 0; ; i++) {
    const r = await fetch(`${TX_API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429 && i < 5) {
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
      continue;
    }
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const lead = s.match(/^1*/)[0].length;
  return "00".repeat(lead) + hex;
}

/** The NEAR transaction whose MPC answer settled `op`/`slot` with `baseTx`. Scans the vault's recent history. */
async function findSettle(vault, op, slot, baseTx, onProgress) {
  let max = null;
  for (let page = 0; page < 6; page++) {
    const list = (await post("/v0/account", { account_id: vault, max_block_height: max })).account_txs || [];
    if (!list.length) return null;
    for (let i = 0; i < list.length; i += 10) {
      const hashes = list.slice(i, i + 10).map((t) => t.transaction_hash);
      onProgress?.(`searching the vault's transactions (${page * list.length + i + hashes.length} read)...`);
      const txs = (await post("/v0/transactions", { tx_hashes: hashes })).transactions || [];
      for (const tx of txs) {
        const { events } = findAttestation(tx);
        const hit = events.find((e) => e.event === "attested" && e.data?.op === op && e.data?.slot === slot && String(e.data?.tx).toLowerCase() === baseTx.toLowerCase());
        if (hit) return tx.transaction.hash;
      }
    }
    max = Math.min(...list.map((t) => t.tx_block_height)) - 1;
  }
  return null;
}

let noble;
const io = {
  nearTx: async (h) => (await post("/v0/transactions", { tx_hashes: [h] })).transactions?.[0] ?? null,
  baseReceipt: async (h) => (await baseRpc("eth_getTransactionReceipt", [h])).result,
  sha256: async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", b)),
  recover: (sig, msg) => noble.secp256k1.Point.fromBytes(noble.secp256k1.recoverPublicKey(sig, msg, { prehash: false })).toBytes(false),
  mpcKeyHex: async () => base58(String(await view(SIGNER, "public_key", { domain_id: 3 })).replace(/^secp256k1:/, "")),
};

function dialog() {
  let d = document.getElementById("verify-dialog");
  if (!d) {
    d = document.createElement("dialog");
    d.id = "verify-dialog";
    d.innerHTML = `<form method="dialog" style="margin:0"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Verify the proof yourself</h3><button class="ghost">Close</button></div></form><div id="verify-body" class="small"></div>`;
    document.body.append(d);
  }
  return d;
}

export function installVerify() {
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-verify-tx]");
    if (!b) return;
    e.preventDefault();
    const d = dialog();
    const body = d.querySelector("#verify-body");
    const vault = b.dataset.vault;
    const op = Number(b.dataset.op);
    const slot = Number(b.dataset.slot);
    const baseTx = b.dataset.verifyTx;
    const say = (html) => (body.innerHTML = html);
    d.showModal();
    say(`<p>This runs in your browser and does not trust the vault. It finds the NEAR transaction in which <code>${esc(vault)}</code> received the MPC's attestation for operation #${esc(op)}, step ${esc(slot + 1)}. It reads Base transaction <code>${esc(baseTx.slice(0, 14))}...</code> from a public Base RPC, rebuilds the payload the MPC signs, and recovers the signature to the MPC network's key.</p><p class="muted">Starting...</p>`);
    try {
      noble ??= await import(NOBLE);
      const near = await findSettle(vault, op, slot, baseTx, (m) => say(`<p class="muted">${esc(m)}</p>`));
      if (!near) {
        say(`<p class="err">The settle transaction was not found in this vault's recent history. Run <code>node scripts/verify-attestation.mjs --latest ${esc(vault)}</code> from the repository instead.</p>`);
        return;
      }
      const res = await verifyAttestation(near, io);
      say(`<p>NEAR transaction <a href="https://testnet.nearblocks.io/txns/${esc(near)}" target="_blank" rel="noopener"><code>${esc(near.slice(0, 12))}...</code></a></p>
<ol class="steps" style="padding-left:0">${res.steps.map((s) => `<li>${s.ok ? '<span class="pill ok">PASS</span>' : '<span class="pill bad">FAIL</span>'} ${esc(s.name)}${s.detail ? `<br><span class="muted mono">${esc(s.detail)}</span>` : ""}</li>`).join("")}</ol>
<p><b>${res.ok ? "Verified: the NEAR MPC network attested this exact Base transaction and log, and you checked it yourself." : "Not verified."}</b></p>`);
    } catch (err) {
      say(`<p class="err">Error: ${esc(String(err.message || err).slice(0, 300))}</p>`);
    }
  });
}
