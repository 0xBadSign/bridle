// Create, deploy and initialise a Bridle vault in ONE transaction from its parent account.
// The vault is a sub-account created without any access key, so it never holds a full-access key;
// `new` adds only the agent and guardian function-call keys.
//
//   node scripts/deploy.mjs deploy/testnet.json [--vault <id>] [--wasm <path>]
//
// Generates agent/guardian keys under ~/.near-credentials/testnet/bridle-keys/<vault>/ (never in
// the repo), prints the vault's Base address and the access-key list as evidence.
import fs from "fs";
import os from "os";
import path from "path";
import { account, actions, accessKeys, baseRpc, derivedKeyHex, evmAddress, foreignKeyHex, log, newKeyFile, send, SIGNER, view } from "./lib.mjs";

const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(args[0], "utf8"));
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const vault = opt("--vault", cfg.vault);
const wasm = opt("--wasm", path.join(os.homedir(), ".cache/bridle-target/near/bridle_vault/bridle_vault.wasm"));
const nearToYocto = (n) => BigInt(Math.round(Number(n) * 1000)) * 10n ** 21n;

const keyDir = path.join(os.homedir(), ".near-credentials", "testnet", "bridle-keys", vault);
const agentPk = newKeyFile(path.join(keyDir, "agent.json"));
const guardianPks = [newKeyFile(path.join(keyDir, "guardian1.json")), newKeyFile(path.join(keyDir, "guardian2.json"))];

const vaultPk = await derivedKeyHex(vault);
const D = evmAddress(vaultPk);
const foreignPk = await foreignKeyHex(3);
const treasury = evmAddress(await derivedKeyHex(cfg.dao, cfg.policy.treasury_path));
const nonce = parseInt((await baseRpc("eth_getTransactionCount", [D, "pending"])).result, 16);
log("vault", vault, "Base address", D, "nonce", nonce, "treasury", treasury);

const { treasury_path, ...pol } = cfg.policy;
const initArgs = {
  owner: cfg.dao,
  signer: SIGNER,
  vault_pk: vaultPk,
  foreign_pk: foreignPk,
  chain: { ...cfg.chain, vault: D },
  floors: cfg.floors,
  policy: { ...pol, treasury },
  start_nonce: nonce,
  agent_key: agentPk,
  guardian_keys: guardianPks,
  key_allowance: nearToYocto(cfg.key_allowance_near).toString(),
};

const parent = account(cfg.parent);
const code = fs.readFileSync(wasm);
log("deploying", code.length, "bytes from", wasm);
const res = await send(parent, vault, [
  actions.createAccount(),
  actions.transfer(nearToYocto(cfg.vault_funding_near)),
  actions.deployContract(code),
  actions.functionCall("new", initArgs, 300n * 10n ** 12n, 0n),
]);
if (res.failures.length) {
  console.error("FAILED", JSON.stringify(res.failures, null, 1));
  process.exit(1);
}
log("deploy tx", res.hash);
await new Promise((r) => setTimeout(r, 3000));
const keys = await accessKeys(vault);
for (const k of keys) {
  const p = k.access_key.permission;
  log("key", k.public_key, p === "FullAccess" ? "FULL ACCESS" : `function-call ${p.FunctionCall.receiver_id} [${p.FunctionCall.method_names.join(",")}] allowance ${p.FunctionCall.allowance}`);
}
if (keys.some((k) => k.access_key.permission === "FullAccess")) {
  console.error("vault has a full-access key: refusing to continue");
  process.exit(1);
}
const st = await view(vault, "get_state");
log("state ok: owner", st.owner, "next_nonce", st.next_nonce, "exposure", JSON.stringify(st.exposure));
fs.writeFileSync(path.join(keyDir, "deployment.json"), JSON.stringify({ vault, D, deploy_tx: res.hash, treasury, dao: cfg.dao }, null, 1));
