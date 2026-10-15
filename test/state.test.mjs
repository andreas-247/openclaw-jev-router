import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../state.mjs';
const setup = t => {
  const directory=mkdtempSync(join(tmpdir(),'router-state-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return join(directory,'private','router.sqlite');
};
test('private plugin SQLite persists across store instances, isolates namespaces and uses 0600',t=>{
  const path=setup(t),a=openStore({path,namespace:'a'}),b=openStore({path,namespace:'b'});
  a.register('chat',{mode:'shadow'});assert.deepEqual(openStore({path,namespace:'a'}).lookup('chat'),{mode:'shadow'});
  assert.equal(b.lookup('chat'),undefined);assert.equal(statSync(path).mode&0o777,0o600);
  assert.equal(statSync(join(path,'..')).mode&0o777,0o700);
});
test('owner assertion failure rolls back control write',t=>{
  const path=setup(t),store=openStore({path,namespace:'a'});store.register('chat',{mode:'off'});
  assert.throws(()=>store.register('chat',{mode:'active'},{assertCurrent(){throw Error('revoked');}}));
  assert.deepEqual(store.lookup('chat'),{mode:'off'});
});
test('store enforces namespace capacity and expiry',async t=>{
  const path=setup(t),store=openStore({path,namespace:'a',maxEntries:2});
  store.register('1',{});store.register('2',{});store.register('3',{});
  assert.equal(store.lookup('1'),undefined);assert.deepEqual(store.lookup('3'),{});
  const expiring=openStore({path,namespace:'ttl',defaultTtlMs:1});expiring.register('x',{});
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(expiring.lookup('x'),undefined);
});
