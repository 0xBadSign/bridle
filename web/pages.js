// Read-only pages. Each takes the polled vault data and returns an HTML string.
import { links, VAULTS } from "./lib/chain.js";
import { actionText, ago, callerLabel, dur, esc, eth, gwei, reasonKey, reasonText, short, usdc, when } from "./lib/fmt.js";

const a = (href, text, cls = "") => `<a href="${esc(href)}" target="_blank" rel="noopener" class="${cls}">${esc(text)}</a>`;
const stat = (label, val, hint = "") => `<div class="card stat"><div class="label">${esc(label)}</div><div class="val">${val}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ""}</div>`;
const kv = (rows) => `<div class="kv">${rows.map(([k, v]) => `<div>${esc(k)}</div><div>${v}</div>`).join("")}</div>`;
const pill = (t, c = "") => `<span class="pill ${c}">${esc(t)}</span>`;

export function banner(d) {
  const s = d.state;
  const now = Date.now();
  if (s.frozen) return ["bad", "FROZEN: the active operation passed its settle deadline without proof. No new operation can start until it is resolved."];
  if (s.paused_until_ms > now) return ["warn", `Paused by a guardian until ${when(s.paused_until_ms)} (${dur(s.paused_until_ms - now)} left). Agent requests are refused while paused.`];
  if (s.active !== null && s.active !== undefined) return ["info", `Operation #${s.active} is in flight. The vault runs one operation at a time.`];
  return null;
}

export function overview(d, key) {
  const s = d.state;
  const L = s.ledger;
  const v = VAULTS[key];
  const inflight = BigInt(L.supplying) + BigInt(L.withdrawing) + BigInt(L.sending);
  const fullKeys = d.keys.filter((k) => k.access_key.permission === "FullAccess");
  const fcKeys = d.keys.filter((k) => k.access_key.permission !== "FullAccess");
  const ex = s.exposure;
  const p = s.policy;
  const now = Date.now();
  const paused = s.paused_until_ms > now;
  return `
<h1>${esc(v.label)}</h1>
<div class="grid">
  <div class="card stat"><div class="label">Requests refused on-chain</div><div class="big">${esc(s.rejection_count)}</div><div class="hint"><a href="#rejections">See every refusal</a></div></div>
  ${stat("Idle at the vault's Base address", esc(usdc(L.idle)), "Free to be supplied or sent")}
  ${stat("In Aave", esc(usdc(L.principal)), "Proved supplied")}
  ${stat("In flight", esc(usdc(inflight)), `Supplying ${usdc(L.supplying)}, withdrawing ${usdc(L.withdrawing)}, sending ${usdc(L.sending)}`)}
  ${stat("Sent to the treasury", esc(usdc(L.total_sent)), "Proved, all time")}
  ${stat("Credited (deposits)", esc(usdc(L.total_credited)), "Proved inbound, all time")}
</div>
<p class="muted small">Every number moves only when the NEAR MPC network attests the matching Base transaction, never on the agent's say-so.</p>

<h2>Status</h2>
<div class="card">${kv([
    ["State", s.frozen ? pill("frozen", "bad") : paused ? pill("paused", "warn") : s.active !== null ? pill(`operation #${s.active} running`, "info") : pill("idle and ready", "ok")],
    ["Vault (NEAR)", a(links.nearAcct(v.id), v.id)],
    ["Vault address (Base)", a(links.baseAddr(s.chain.vault), s.chain.vault, "mono")],
    ["Owner DAO", a(links.nearAcct(s.owner), s.owner) + ' <span class="muted small">(Sputnik DAO; acts by predecessor)</span>'],
    ["MPC signer contract", a(links.nearAcct(s.signer), s.signer)],
    ["Guardians", s.guardians.length ? s.guardians.map((g) => `<div><code>${esc(g)}</code></div>`).join("") + '<div class="muted small">Function-call keys that can pause, veto, tighten or unwind. They can never loosen anything.</div>' : "none"],
    ["Agent key", `<code>${esc(s.agent_key)}</code> <span class="muted small">can call only <code>agent_act</code></span>`],
    ["Next Base nonce", esc(s.next_nonce)],
    ["Agent actions this epoch", `${esc(s.epoch.agent_actions)} of ${esc(p.agent_quota_per_epoch)}`],
    ["Fast outflow used this epoch", `${esc(usdc(s.epoch.fast_outflow_used))} of ${esc(usdc(p.fast_outflow_per_epoch))}`],
  ])}</div>

<h2>What can leave this vault (<code>exposure()</code>)</h2>
<div class="card">${kv([
    ["Most that can leave without a vetoable vote this epoch", `<b>${esc(usdc(ex.fast_outflow_per_epoch))}</b>`],
    ["Most that can sit in Aave", `<b>${esc(usdc(ex.max_in_protocol))}</b> <span class="muted small">(Aave's risk applies to this amount)</span>`],
    ["Most the agent can move per epoch", `<b>${esc(usdc(ex.agent_moves_per_epoch))}</b> <span class="muted small">between the vault address and Aave; it never leaves the vault address</span>`],
    ["Most Base gas the agent can burn per epoch", `<b>${esc(eth(ex.agent_gas_wei_per_epoch))}</b>`],
  ])}
<p class="muted small">Computed by the same code that enforces the policy. It holds if the NEAR MPC network, Base and Aave behave; it is not a loss guarantee.</p></div>

<h2>The mandate (policy voted by the DAO)</h2>
<div class="card">${kv([
    ["Cap on funds in Aave", esc(usdc(p.supply_cap))],
    ["Agent: most per action", esc(usdc(p.agent_max_per_action))],
    ["Agent: actions per epoch", esc(p.agent_quota_per_epoch)],
    ["Agent: minimum gap between actions", esc(dur(p.agent_min_interval_ms))],
    ["DAO outflow allowed without parking", esc(usdc(p.fast_outflow_per_epoch)) + " per epoch"],
    ["Fee cap", `${esc(gwei(p.max_fee_per_gas))} max, ${esc(gwei(p.max_priority_fee_per_gas))} priority`],
    ["Parking windows", `short ${esc(dur(p.short_window_ms))}, long ${esc(dur(p.long_window_ms))} (a guardian can veto while an item waits)`],
    ["Settle deadline", `${esc(dur(p.settle_deadline_ms))} to prove a transaction landed before the vault freezes`],
    ["Epoch length", esc(dur(p.epoch_ms))],
    ["Longest guardian pause", esc(dur(p.max_pause_ms))],
    ["Treasury (Base)", a(links.baseAddr(p.treasury), p.treasury, "mono")],
  ])}</div>

<h2>Access keys on the vault account</h2>
<div class="card">
  ${fullKeys.length
    ? `<div class="banner bad">This account has ${fullKeys.length} full-access key(s).</div>`
    : `<div class="banner" style="background:var(--ok-bg);color:var(--ok);border-color:var(--ok)"><b>No full-access key.</b> Nobody can deploy code, transfer NEAR or sign as this account outside the contract's own rules.</div>`}
  <p class="muted small">Read live from the NEAR RPC (<code>view_access_key_list</code>), ${d.keys.length} key(s) in total.</p>
  <div class="tablewrap"><table><thead><tr><th>Public key</th><th>Permission</th><th>Methods</th><th>Gas allowance</th></tr></thead><tbody>
  ${fcKeys.map((k) => {
    const fc = k.access_key.permission.FunctionCall;
    const role = k.public_key === s.agent_key ? pill("agent", "info") : s.guardians.includes(k.public_key) ? pill("guardian", "warn") : "";
    const allow = fc.allowance === null ? "unlimited" : (Number(BigInt(fc.allowance) / 10n ** 20n) / 1e4).toFixed(4) + " NEAR";
    return `<tr><td><code>${esc(k.public_key)}</code> ${role}</td><td>function call on <code>${esc(fc.receiver_id)}</code></td><td>${esc((fc.method_names.length ? fc.method_names : ["any method"]).join(", "))}</td><td>${esc(allow)}</td></tr>`;
  }).join("") || `<tr><td colspan="4" class="muted">No keys.</td></tr>`}
  ${fullKeys.map((k) => `<tr><td><code>${esc(k.public_key)}</code></td><td>${pill("FULL ACCESS", "bad")}</td><td></td><td></td></tr>`).join("")}
  </tbody></table></div>
</div>`;
}

// ---------------------------------------------------------------------------------------------

const slotName = (c) => ({ approve: "Approve USDC", supply: "Supply to Aave", withdraw: "Withdraw from Aave", transfer: "Transfer USDC", cancel: "Cancel" })[c?.call] || c?.call || "step";

function slotStatus(st) {
  if (st === "unreserved") return pill("not started", "");
  if (st === "open") return pill("in progress", "info");
  if (st === "trusted_landed") return pill("declared landed by the DAO", "warn");
  if (st.landed) return pill("landed", "ok");
  if (st.reverted) return pill(st.reverted.by_dao ? "declared failed by the DAO" : "reverted", "bad");
  return pill(JSON.stringify(st));
}

export function waitingFor(op, wait) {
  const slot = op.slots[op.cursor];
  if (!slot) return "";
  if (slot.signing) return "the NEAR MPC network's signature";
  if (slot.verifying) return "the NEAR MPC network's attestation that the transaction landed";
  if (slot.status === "unreserved" || (slot.sign_unknown && !slot.main?.signed?.length)) return "a keeper to call advance (reserve the nonce and request the signature)";
  if (!wait) return "a keeper to broadcast, wait for the Base safe head and settle";
  if (wait.stage === "broadcast") return "a keeper to broadcast the signed transaction to Base";
  if (wait.stage === "safe") return `the Base <code>safe</code> head to reach the transaction's block (mined in block ${esc(wait.block)}, safe head is ${esc(wait.safe)})`;
  if (wait.stage === "cooldown") return "the verification cooldown to pass";
  return "a keeper to call settle so the MPC network can attest the landing";
}

export function ops(d, wait) {
  const list = [...d.ops].sort((x, y) => y.id - x.id);
  const now = Date.now();
  if (!list.length) return `<h1>Operations</h1><p class="muted">No operations yet. The vault keeps the most recent 64.</p>`;
  return `<h1>Operations</h1><p class="muted small">Each operation is a short list of Base transactions. The vault builds them, the NEAR MPC network signs them, and a step counts only after the same network attests it succeeded on Base.</p>` +
    list.map((op) => {
      const active = op.status === "active";
      return `<div class="card ${active ? "active" : ""}" style="margin-bottom:12px">
  <div class="row"><h3 style="margin:0">Operation #${esc(op.id)}</h3> ${pill(op.status, op.status === "done" ? "ok" : op.status === "aborted" ? "bad" : "info")} ${pill("by " + op.origin)}
  <span>${esc(actionText(op.action))}</span> <span class="muted small">created ${esc(ago(op.created_ms, now))} (${esc(when(op.created_ms))})</span></div>
  ${active ? `<div class="waiting">Waiting for: ${waitingFor(op, wait)}</div>` : ""}
  ${op.slots.map((sl, i) => {
    const cur = active && i === op.cursor;
    const landed = sl.status && sl.status.landed;
    const drafts = [["main", sl.main], ["cancel", sl.cancel], ["probe", sl.probe]].filter(([, x]) => x);
    return `<div class="slot"><b>${i + 1}. ${esc(slotName(sl.call))}</b>${sl.call.amount !== undefined ? ` ${esc(usdc(sl.call.amount))}` : ""}
      ${slotStatus(sl.status)} ${landed ? pill("attested by the MPC network", "ok") : ""} ${cur ? pill("current step", "info") : ""}
      ${sl.signing ? pill("MPC is signing", "info") : ""} ${sl.verifying ? pill("MPC is verifying", "info") : ""}
      ${drafts.map(([w, x]) => `<span class="small muted">${esc(w)}: nonce ${esc(x.params.nonce)}${x.signed.length ? ", " + x.signed.map((t) => a(links.baseTx(t.hash), short(t.hash, 10, 6), "mono")).join(" ") : ", not signed yet"}</span>`).join(" ")}
      ${landed ? `<span class="small muted">proved by ${a(links.baseTx(sl.status.landed.tx), short(sl.status.landed.tx, 10, 6), "mono")}</span>` : ""}
    </div>`;
  }).join("")}
</div>`;
    }).join("");
}

// ---------------------------------------------------------------------------------------------

const EX_LABEL = { max_in_protocol: "Most in Aave", agent_moves_per_epoch: "Agent moves per epoch", fast_outflow_per_epoch: "Fast outflow per epoch", agent_gas_wei_per_epoch: "Agent gas per epoch" };
const exFmt = (k, v) => (k === "agent_gas_wei_per_epoch" ? eth(v) : usdc(v));

function parkedKind(k) {
  if (k.kind === "outflow") return `Send ${esc(usdc(k.amount))} to the treasury`;
  if (k.kind === "policy") return `Change the policy <details><summary class="small">show new policy</summary><pre class="log">${esc(JSON.stringify(k.policy, null, 1))}</pre></details>`;
  if (k.kind === "add_guardian") return `Add guardian <code>${esc(k.public_key)}</code>`;
  if (k.kind === "upgrade") return `Upgrade the contract to code hash <code>${esc(JSON.stringify(k.code_hash))}</code>`;
  return esc(JSON.stringify(k));
}

export function parked(d) {
  const now = Date.now();
  const list = [...d.parked].sort((x, y) => y.id - x.id);
  if (!list.length) return `<h1>Parked queue</h1><p class="muted">Nothing parked. Risky DAO actions (large outflows, loosening the policy, new guardians, upgrades) wait here for a window in which a guardian can veto them.</p>`;
  return `<h1>Parked queue</h1><p class="muted small">Risky DAO actions wait here. A guardian can veto until the unlock time; after expiry nothing happens.</p>` +
    list.map((p) => {
      const cls = { waiting: "info", executed: "ok", vetoed: "bad", expired: "warn" }[p.status] || "";
      let timing;
      if (p.status === "waiting") timing = now < p.unlock_ms ? `unlocks in <b>${esc(dur(p.unlock_ms - now))}</b>` : `unlocked ${esc(ago(p.unlock_ms, now))}, expires in ${esc(dur(Math.max(0, p.expires_ms - now)))}`;
      else timing = `unlock was ${esc(when(p.unlock_ms))}`;
      const rows = Object.keys(EX_LABEL).map((k) => {
        const b = p.exposure_before[k], af = p.exposure_after[k];
        return `<tr><td>${esc(EX_LABEL[k])}</td><td>${esc(exFmt(k, b))}</td><td>${b === af ? "same" : "&rarr; <b>" + esc(exFmt(k, af)) + "</b>"}</td></tr>`;
      }).join("");
      return `<div class="card" style="margin-bottom:12px">
  <div class="row"><h3 style="margin:0">Item #${esc(p.id)}</h3> ${pill(p.status, cls)} ${pill(p.lane + " lane")}</div>
  <p style="margin:6px 0">${parkedKind(p.kind)}</p>
  <div class="small muted">created ${esc(ago(p.created_ms, now))}; ${timing}; expires ${esc(when(p.expires_ms))}</div>
  <div class="tablewrap"><table><thead><tr><th>Exposure</th><th>Before</th><th>After</th></tr></thead><tbody>${rows}</tbody></table></div>
</div>`;
    }).join("");
}

// ---------------------------------------------------------------------------------------------

export function rejections(d) {
  const now = Date.now();
  const list = [...d.rej.recent].reverse();
  return `<h1>Refusals</h1>
<p class="muted">The vault records every refused request in a public on-chain ledger: <b>${esc(d.rej.count)}</b> so far, the latest ${list.length} shown (it keeps 64).</p>
${list.length ? `<div class="card tablewrap"><table><thead><tr><th>When</th><th>Caller</th><th>Method</th><th>Reason</th></tr></thead><tbody>
${list.map((r) => `<tr><td>${esc(ago(r.at_ms, now))}<div class="small muted">${esc(when(r.at_ms))}</div></td><td>${pill(typeof r.caller === "string" ? r.caller : "guardian", "")} ${typeof r.caller === "object" ? `<code class="small">${esc(short(r.caller.guardian, 12, 4))}</code>` : ""}</td><td><code>${esc(r.method)}</code></td><td>${pill(reasonKey(r.reason), "bad")} ${esc(reasonText(r.reason))}</td></tr>`).join("")}
</tbody></table></div>` : `<p class="muted">No refusals yet. Try the <a href="#arena">Arena</a>.</p>`}`;
}

// ---------------------------------------------------------------------------------------------

export function how() {
  const box = (x, y, w, t, s, hot) => `<rect x="${x}" y="${y}" width="${w}" height="54" rx="10" class="${hot ? "hot" : ""}"/><text x="${x + w / 2}" y="${y + 23}" text-anchor="middle" font-weight="600">${t}</text><text x="${x + w / 2}" y="${y + 40}" text-anchor="middle" class="sub">${s}</text>`;
  return `<h1>How it works</h1>
<div class="card">
<svg class="diagram" viewBox="0 0 860 290" role="img" aria-label="Loop: agent, vault policy check, MPC signs, Base, MPC attests, vault ledger">
<defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z"/></marker></defs>
${box(10, 20, 170, "AI agent", "key: agent_act only")}
${box(250, 20, 190, "Vault (NEAR)", "checks the mandate, builds the tx", true)}
${box(510, 20, 170, "NEAR MPC network", "signs the exact payload")}
${box(690, 110, 160, "Base", "keeper broadcasts the tx")}
${box(510, 200, 170, "NEAR MPC network", "attests it succeeded")}
${box(250, 200, 190, "Vault ledger", "moves only on attestation", true)}
<path d="M180 47 H250"/><path d="M440 47 H510"/><path d="M680 47 C770 47 770 80 770 110"/><path d="M770 164 C770 227 740 227 680 227"/><path d="M510 227 H440"/>
<path d="M345 200 V74" stroke-dasharray="5 4"/>
<text x="352" y="140" class="sub">next step allowed only after the ledger moved</text>
<text x="215" y="40" text-anchor="middle" class="sub">request</text>
<text x="10" y="150" class="sub">Refused requests are recorded on-chain:</text><text x="10" y="168" class="sub">the rejection ledger.</text>
</svg>
<ol>
<li>The agent asks for a typed action (supply, withdraw, send to the treasury, unwind). There is no destination field: funds can only go to the vault itself, Aave or the DAO-set treasury.</li>
<li>The vault checks the request against the DAO-voted mandate (limits, quota, spacing, fee caps). A refusal is written to the public rejection ledger.</li>
<li>If it passes, the vault itself builds the Base transaction and asks the NEAR MPC network to sign that exact payload. The agent never sees a key or a signature.</li>
<li>Anyone (a "keeper", possibly your browser on the Arena page) broadcasts the signed transaction to Base and waits for the <code>safe</code> head.</li>
<li>The same MPC network attests that the transaction succeeded on Base. Only then does the vault update its ledger and allow the next step.</li>
</ol>
</div>

<h2>What is not protected</h2>
<div class="card">
<ul>
<li><b>The NEAR MPC network.</b> Bridle trusts its threshold: if enough nodes collude, they can sign anything for the vault's address.</li>
<li><b>RPC providers.</b> A lying Base RPC can delay or confuse keepers. The MPC attestation is what the vault trusts, but the attesters read Base through providers too.</li>
<li><b>The DAO majority, after the window.</b> A DAO vote can change the mandate. Risky changes wait in the parked queue where a guardian can veto, but a determined majority that waits out the window wins.</li>
<li><b>Aave, the USDC issuer and the Base sequencer.</b> Funds in Aave carry Aave's risk (capped by the policy); USDC can be frozen by its issuer; the sequencer can censor or reorder.</li>
<li><b>Testnet only.</b> This deployment uses Base Sepolia test USDC and NEAR testnet.</li>
</ul>
<p class="muted small">The numbers in <code>exposure()</code> hold only if the first four items behave. They are conditional, not a loss guarantee.</p>
</div>`;
}
