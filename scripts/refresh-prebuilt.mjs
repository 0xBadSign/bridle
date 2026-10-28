// Refresh deploy/prebuilt/ from the code that is actually deployed on testnet.
//
//   node scripts/refresh-prebuilt.mjs                    fetch, check, write bridle_vault.wasm + SHA256SUMS
//   node scripts/refresh-prebuilt.mjs --check            only compare; exit 1 if the prebuilt file is stale
//   node scripts/refresh-prebuilt.mjs --mock <file.wasm> also replace bridle_mock_signer.wasm
//
// The vault wasm is fetched with the RPC `view_code` query from vault.bridle-hq.testnet and
// arena.bridle-hq.testnet. Both must run the same code (same code hash); otherwise nothing is
// written. The file is saved as served, so it is byte-identical to the deployed code by
// construction (base58(sha256(wasm)) equals the account's code_hash). Read-only against the chain.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { baseEncode } from "near-api-js";
import { nearRpc } from "./lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "deploy/prebuilt");
const ACCOUNTS = ["vault.bridle-hq.testnet", "arena.bridle-hq.testnet"];
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const mockSrc = args.includes("--mock") ? args[args.indexOf("--mock") + 1] : null;
const sha = (buf) => crypto.createHash("sha256").update(buf).digest();

const fetched = [];
for (const id of ACCOUNTS) {
  const r = await nearRpc("query", { request_type: "view_code", finality: "final", account_id: id });
  if (!r.result) throw new Error(`view_code ${id}: ${JSON.stringify(r.error)}`);
  const code = Buffer.from(r.result.code_base64, "base64");
  const hash = baseEncode(sha(code));
  if (hash !== r.result.hash) throw new Error(`${id}: served code does not hash to its code_hash`);
  console.log(`${id}: ${hash} (${code.length} bytes)`);
  fetched.push({ id, code, hash });
}
if (fetched[0].hash !== fetched[1].hash) {
  console.error("the two vaults run different code; refusing to write a prebuilt file");
  process.exit(1);
}
const { code, hash } = fetched[0];
const file = path.join(DIR, "bridle_vault.wasm");
const current = fs.existsSync(file) ? sha(fs.readFileSync(file)) : null;
const fresh = current && baseEncode(current) === hash;
console.log(fresh ? "prebuilt bridle_vault.wasm matches the deployed code" : "prebuilt bridle_vault.wasm is STALE (differs from the deployed code)");
if (checkOnly) process.exit(fresh ? 0 : 1);

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(file, code);
if (mockSrc) fs.copyFileSync(mockSrc, path.join(DIR, "bridle_mock_signer.wasm"));
const lines = ["bridle_vault.wasm", "bridle_mock_signer.wasm"].map((f) => `${sha(fs.readFileSync(path.join(DIR, f))).toString("hex")}  ${f}`);
fs.writeFileSync(path.join(DIR, "SHA256SUMS"), lines.join("\n") + "\n");
console.log(`wrote deploy/prebuilt/bridle_vault.wasm and SHA256SUMS (code hash ${hash})`);
console.log(lines.join("\n"));
