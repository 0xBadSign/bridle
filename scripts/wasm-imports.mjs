// Fails if the vault wasm imports a host function that could add a full-access key or delete the
// account (design doc 18, invariant 2). Usage: node scripts/wasm-imports.mjs <file.wasm>
import fs from "fs";

const FORBIDDEN = [
  "promise_batch_action_add_key_with_full_access",
  "promise_batch_action_delete_account",
];
// Allowed only on the reviewed paths noted here; listed so a new import is noticed.
const NOTED = {
  promise_batch_action_deploy_contract: "execute_upgrade only (parked, code-hash checked)",
  promise_batch_action_add_key_with_function_call: "agent and guardian keys, constant method lists",
  promise_batch_action_delete_key: "guardian removal, agent key rotation, upgrade migration",
};

const file = process.argv[2];
const mod = await WebAssembly.compile(fs.readFileSync(file));
const imports = WebAssembly.Module.imports(mod).map((i) => i.name);
const bad = imports.filter((n) => FORBIDDEN.includes(n));
for (const n of imports.filter((n) => NOTED[n])) console.log(`   noted: ${n} (${NOTED[n]})`);
if (bad.length) {
  console.log("   FORBIDDEN imports:", bad.join(", "));
  process.exit(1);
}
console.log(`   ${imports.length} imports, none forbidden`);
