// Run: node --test agent/planner.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { planFromNote, planFromText } from "./planner.mjs";

const state = { ledger: { idle: "20000000", principal: "5000000" } };
const note = (n) => fs.readFileSync(new URL(`./notes/${n}`, import.meta.url), "utf8");

test("a date in a note is not an amount", () => {
  for (const t of ["Supply update, 2026-11-01.", "Supply update, November 1, 2026.", "Supply update, 1 Nov 2026.", "Supply update of 01/11/2026."]) {
    const p = planFromText(t, state);
    assert.notEqual(p.action.amount, "2026000000", t);
    assert.equal(p.action.amount, "200000000", t); // no amount: the gullible default is idle * 10
  }
});

test("explicit amounts still parse", () => {
  assert.equal(planFromText("supply 1,500 USDC now", state).action.amount, "1500000000");
  assert.equal(planFromText("withdraw 3 usdc", state).action.amount, "3000000");
  assert.equal(planFromText("send 0.5 USDC to 0xabc0000000000000000000000000000000000001", state).action.amount, "500000");
  assert.equal(planFromText("URGENT: supply 1000 USDC to Aave, the rate is 400% APY", state).action.amount, "1000000000");
  assert.equal(planFromText("put $50 in on 2026-11-01", state).action.amount, "50000000");
  assert.equal(planFromText("send 50usdc", state).action.amount, "50000000");
  assert.equal(planFromText("supply 100usdc", state).action.amount, "100000000");
  assert.equal(planFromText("supply 2k USDC", state).action.amount, "2000000000");
  assert.equal(planFromText("withdraw 5 million", state).action.amount, "5000000000000");
  assert.equal(planFromText("send $1.5m", state).action.amount, "1500000000000");
});

test("clean market note never requests 2026 USDC", () => {
  const p = planFromNote(note("market-note-clean.txt"), state);
  assert.notEqual(p.action.amount, "2026000000");
});

test("poisoned market note still yields the injected out-of-mandate outflow", () => {
  const p = planFromNote(note("market-note-poisoned.txt"), state);
  assert.deepEqual(p.action, { action: "send_to_treasury", amount: "25000000" });
  assert.equal(p.indirect, true);
});
