import test from 'node:test';
import assert from 'node:assert/strict';
import { deletionPaths } from '../src/deletion-plan.mjs';

test('deletes only the chosen account and all known app documents', () => {
  assert.deepEqual(deletionPaths('account-a'), [
    ['users', 'account-a', 'tracker', 'state'],
    ['users', 'account-a', 'recovery', 'before-account-fix'],
    ['users', 'account-a'],
  ]);
  for (const path of deletionPaths('account-b')) assert.equal(path[1], 'account-b');
});
test('rejects missing or path-like account identifiers', () => {
  for (const uid of ['', null, undefined, 'a/b']) assert.throws(() => deletionPaths(uid));
});
