import { test } from "node:test";
import assert from "node:assert/strict";
import { accountRecordState, createAccountLease } from "../src/account-policy.mjs";

test("new accounts never inherit another account's records", () => {
  assert.equal(accountRecordState("new-user", undefined), "new");
  assert.equal(accountRecordState("new-user", { ownerUid: "old-user", readings: [8901] }), "blocked");
});
test("old records require review instead of being silently adopted or deleted", () => {
  assert.equal(accountRecordState("user", { readings: [8901] }), "review");
  assert.equal(accountRecordState("user", { ownerUid: "user", readings: [8901] }), "owned");
});
test("callbacks from an old account cannot publish into a new session", () => {
  let current = "alice";
  const alice = createAccountLease("alice", () => current);
  assert.equal(alice.valid(), true);
  current = "bob";
  assert.equal(alice.valid(), false);
  alice.close();
  current = "alice";
  assert.equal(alice.valid(), false);
  assert.equal(createAccountLease("alice", () => current).valid(), true);
});
