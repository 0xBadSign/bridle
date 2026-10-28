// Live testnet suite for the paths the quick demo does not cover. Prints PASS/FAIL lines with
// NEAR and Base evidence. Takes ~30-40 minutes because of the parking windows and Base `safe` lag.
//
//   node scripts/live-suite.mjs [--vault vault.bridle-hq.testnet] [--only <step,...>]
//
// Uses the DAO council key (bridle-hq.testnet) and the vault's agent/guardian keys from
// ~/.near-credentials/testnet/bridle-keys/<vault>/.
import crypto from "crypto";
import fs from "fs";
import os from "os";
import { account, accessKeys, baseRpc, call, log, newKeyFile, sleep, view } from "./lib.mjs";
import { daoCall } from "./dao.mjs";
import { Keeper } from "../agent/keeper.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const V = opt("--vault", "vault.bridle-hq.testnet");
const only = opt("--only", "").split(",").filter(Boolean);
const DAO = "bridle-hq.sputnik-v2.testnet";
const COUNCIL = "bridle-hq.testnet";
const KD = `${os.homedir()}/.near-credentials/testnet/bridle-keys/${V}`;
const WASM = `${os.homedir()}/.cache/bridle-target/near/bridle_vault/bridle_vault.wasm`;
const results = [];
const check = (name, ok, evidence = "") => {
  results.push({ name, ok, evidence });
  log(ok ? "PASS" : "FAIL", name, evidence);
};
const keeper = new Keeper(V, COUNCIL);
const agent = () => account(V, `${KD}/agent.json`);
const guardian = (n) => account(V, `${KD}/guardian${n}.json`);
const state = () => view(V, "get_state");
const dao = (method, a, d) => daoCall(DAO, COUNCIL, V, method, a, d);
const rejectedReason = (r) => r?.value?.rejected?.reason;

async function drain(maxMs = 15 * 60_000) {
  const t0 = Date.now();
  for (let did; (did = await keeper.tick()) !== null; ) {
    if (Date.now() - t0 > maxMs) return false;
    log("   keeper:", did);
    await sleep(/waiting|cooldown/.test(did) ? 8000 : 1500);
  }
  return true;
}

async function waitUntil(ms, why) {
  const left = ms - Date.now();
  if (left > 0) {
    log(`   waiting ${Math.ceil(left / 1000)} s (${why})`);
    await sleep(left + 2000);
  }
}

const steps = {
  async withdraw() {
    const before = (await state()).ledger;
    const r = await call(agent(), V, "agent_act", { action: { action: "withdraw", amount: "5000000" } }, { gasT: 150 });
    await drain();
    const after = (await state()).ledger;
    check("agent withdraw 5 USDC lands and is attested", r.value?.ok && BigInt(after.principal) === BigInt(before.principal) - 5_000_000n && BigInt(after.idle) === BigInt(before.idle) + 5_000_000n, `near ${r.hash}`);
  },

  async cancel() {
    // DAO orders a supply; a guardian cancels it before anyone broadcasts. Only the cancel lands.
    const before = (await state()).ledger;
    const d = await dao("dao_act", { action: { action: "supply", amount: "5000000" } }, "Supply 5 USDC (to be cancelled)");
    const st = await state();
    const op = await view(V, "get_op", { id: st.active });
    const g = await call(guardian(1), V, "cancel", {}, { gasT: 150 });
    const op2 = await view(V, "get_op", { id: st.active });
    const c = op2.slots[0].cancel?.signed?.[0];
    if (c) await keeper.broadcast(c.raw);
    log("   cancel tx", c?.hash, "main tx (never broadcast by us)", op.slots[0].main?.signed?.[0]?.hash);
    await drain();
    const after = (await state()).ledger;
    const done = await view(V, "get_op", { id: st.active });
    check("guardian cancel at the same nonce replaces an unbroadcast approve; reservation released", done.status === "aborted" && after.idle === before.idle && after.supplying === "0", `dao ${d.act_tx}, cancel near ${g.hash}, base ${c?.hash}`);
  },

  async pause() {
    const g = await call(guardian(1), V, "guardian_pause", { duration_ms: 600000 }, { gasT: 100 });
    const a = await call(agent(), V, "agent_act", { action: { action: "supply", amount: "1000000" } }, { gasT: 150 });
    const again = await call(guardian(2), V, "guardian_pause", { duration_ms: 600000 }, { gasT: 100 });
    const u = await dao("dao_unpause", {}, "Lift the guardian pause");
    const st = await state();
    check("guardian pause blocks the agent; re-pause inside the cooldown refused; DAO lifts it", g.value?.ok && rejectedReason(a) === "paused" && rejectedReason(again) === "pause_cooldown" && st.paused_until_ms <= st.now_ms, `pause ${g.hash}, agent ${a.hash}, unpause ${u.act_tx}`);
  },

  async policy() {
    const p = (await state()).policy;
    const tighter = { ...p, agent_max_per_action: "40000000" };
    const t = await dao("propose_policy", { policy: tighter }, "Tighten: agent max 40 USDC");
    const st1 = await state();
    check("DAO tightening applies immediately", st1.policy.agent_max_per_action === "40000000", `dao ${t.act_tx} events ${t.events}`);
    const looser = { ...st1.policy, agent_max_per_action: "50000000" };
    const l = await dao("propose_policy", { policy: looser }, "Loosen back: agent max 50 USDC");
    const parked = (await view(V, "get_parked")).at(-1);
    const early = await call(account(COUNCIL), V, "execute", { id: parked.id }, { gasT: 150 });
    check("DAO loosening is parked (short lane) and cannot execute early", parked.lane === "short" && parked.status === "waiting" && rejectedReason(early) === "not_yet_unlocked", `dao ${l.act_tx}, parked ${parked.id}`);
    await waitUntil(parked.unlock_ms, "short window");
    const ex = await call(account(COUNCIL), V, "execute", { id: parked.id }, { gasT: 150 });
    check("parked loosening executes after the window", (await state()).policy.agent_max_per_action === "50000000", `execute ${ex.hash}`);
  },

  async rotate() {
    const fresh = `${KD}/agent-next.json`;
    const pk = newKeyFile(fresh);
    const oldPk = (await state()).agent_key;
    const r = await dao("set_agent_key", { public_key: pk }, "Rotate the agent key");
    await sleep(4000);
    const keys = (await accessKeys(V)).map((k) => k.public_key);
    let oldWorks = true;
    try {
      await call(agent(), V, "agent_act", { action: { action: "supply", amount: "1" } }, { gasT: 150 });
    } catch (e) {
      oldWorks = false;
    }
    fs.renameSync(`${KD}/agent.json`, `${KD}/agent-retired-${Date.now()}.json`);
    fs.renameSync(fresh, `${KD}/agent.json`);
    const n = await call(agent(), V, "agent_act", { action: { action: "supply", amount: "999000000" } }, { gasT: 150 });
    check("DAO rotates the agent key: old key deleted, new key reaches the vault", !keys.includes(oldPk) && keys.includes(pk) && !oldWorks && rejectedReason(n) === "above_agent_max", `dao ${r.act_tx}, new key call ${n.hash}`);
  },

  async guardians() {
    const g3 = newKeyFile(`${KD}/guardian3.json`);
    const p = await dao("propose_guardian", { public_key: g3 }, "Add a third guardian");
    const parked = (await view(V, "get_parked")).at(-1);
    const st = await state();
    const g2 = st.guardians[1];
    const rm = await dao("remove_guardian", { public_key: g2 }, "Remove guardian 2");
    await sleep(4000);
    const keys = (await accessKeys(V)).map((k) => k.public_key);
    const g2try = await call(guardian(2), V, "guardian_veto", { id: parked.id }, { gasT: 100 }).catch((e) => ({ error: String(e.message).slice(0, 80) }));
    check("DAO removes a guardian at once; its key is deleted", !keys.includes(g2) && !(await state()).guardians.includes(g2) && !!g2try.error, `dao ${rm.act_tx}`);
    await waitUntil(parked.unlock_ms, "long window for adding a guardian");
    const ex = await call(account(COUNCIL), V, "execute", { id: parked.id }, { gasT: 150 });
    await sleep(4000);
    const keys2 = (await accessKeys(V)).map((k) => k.public_key);
    check("adding a guardian waits the long window, then its key is added", parked.lane === "long" && keys2.includes(g3) && (await state()).guardians.includes(g3), `propose ${p.act_tx}, execute ${ex.hash}`);
  },

  async upgrade() {
    const code = fs.readFileSync(WASM);
    const hash = "0x" + crypto.createHash("sha256").update(code).digest("hex");
    const before = await state();
    const p = await dao("propose_upgrade", { code_hash: hash }, `Upgrade to code ${hash.slice(0, 18)}`);
    const parked = (await view(V, "get_parked")).at(-1);
    const early = await call(account(COUNCIL), V, "execute", { id: parked.id }, { gasT: 150 });
    await waitUntil(parked.unlock_ms, "long window for an upgrade");
    const ex = await call(account(COUNCIL), V, "execute", { id: parked.id }, { gasT: 150 });
    // Wrong code is refused even after the window.
    const { actions } = await import("near-api-js");
    const { send } = await import("./lib.mjs");
    const borsh = (buf) => Buffer.concat([Buffer.from(new Uint32Array([buf.length]).buffer), buf]);
    const bad = await send(account(COUNCIL), V, [actions.functionCall("execute_upgrade", borsh(Buffer.from("not the approved code")), 300n * 10n ** 12n, 0n)]);
    const up = await send(account(COUNCIL), V, [actions.functionCall("execute_upgrade", borsh(code), 300n * 10n ** 12n, 0n)]);
    await sleep(5000);
    const after = await state();
    const keys = await accessKeys(V);
    check("upgrade: parked by code hash, refused early, refused with other code, applied with the exact code; state and keys survive",
      parked.lane === "long" && rejectedReason(early) === "not_yet_unlocked" && rejectedReason(bad) === "code_hash_mismatch" && up.value?.ok && up.events.some((e) => e.event === "migrated") &&
      after.ledger.principal === before.ledger.principal && keys.every((k) => k.access_key.permission !== "FullAccess"),
      `propose ${p.act_tx}, upgrade ${up.hash}`);
  },

  async unwind() {
    const before = (await state()).ledger;
    const r = await call(guardian(1), V, "guardian_unwind", {}, { gasT: 150 });
    await drain();
    const after = (await state()).ledger;
    check("guardian unwind pulls all principal back to the vault address; nothing leaves it", r.value?.ok && after.principal === "0" && BigInt(after.idle) === BigInt(before.idle) + BigInt(before.principal) && after.total_sent === before.total_sent, `near ${r.hash}`);
  },

  async final() {
    const keys = await accessKeys(V);
    const rej = await view(V, "get_rejections");
    const d = (await state()).chain.vault;
    const usdc = await baseRpc("eth_call", [{ to: "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f", data: "0x70a08231" + d.slice(2).padStart(64, "0") }, "latest"]);
    const st = await state();
    check("no full-access key on the vault", keys.every((k) => k.access_key.permission !== "FullAccess"), keys.map((k) => Object.keys(k.access_key.permission.FunctionCall ? { fc: 1 } : { full: 1 })[0]).join(","));
    check("ledger idle matches the real USDC balance at the vault's Base address", BigInt(usdc.result) === BigInt(st.ledger.idle), `on-chain ${BigInt(usdc.result)} ledger ${st.ledger.idle}`);
    log("rejections recorded:", rej.count);
  },
};

for (const [name, fn] of Object.entries(steps)) {
  if (only.length && !only.includes(name)) continue;
  log(`== ${name}`);
  try {
    await fn();
  } catch (e) {
    check(`${name} (threw)`, false, String(e.message || e).slice(0, 300));
  }
}
console.log("\nSUMMARY");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.evidence ? `  [${r.evidence}]` : ""}`);
fs.writeFileSync(`live-suite-${Date.now()}.log`, JSON.stringify(results, null, 1));
process.exit(results.every((r) => r.ok) ? 0 : 1);
