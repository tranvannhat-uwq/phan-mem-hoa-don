import assert from 'node:assert/strict';
import test from 'node:test';
import { createInventoryGateway, estimateInventoryUsage, inventoryCycleStart, validateInventoryDocument } from '../js/domain/inventory.js';

test('capacity forecast reserves 0.5 GB below the Free egress limit', () => {
  const normal = estimateInventoryUsage();
  assert.equal(normal.withinFree, true);
  assert.equal(normal.demandBytes, 280320000);
  assert.ok(normal.estimatedTotalGB < 4.5);
  const burst = estimateInventoryUsage({ readsPerUserPerDay: 1000, responseBytes: 32768 });
  assert.equal(burst.allowedBytes, 400000000);
  assert.equal(burst.budgetWouldStopReads, true);
  assert.ok(burst.estimatedTotalGB < 4.5);
  assert.equal(estimateInventoryUsage({ baselineGB: 4.4 }).withinFree, false);
});
test('billing-cycle boundaries use the configured Bangkok day 21', () => {
  assert.equal(inventoryCycleStart(new Date('2026-10-20T16:59:00Z')), '2026-09-21');
  assert.equal(inventoryCycleStart(new Date('2026-10-20T17:00:00Z')), '2026-10-21');
  assert.equal(inventoryCycleStart(new Date('2026-01-05T00:00:00Z')), '2025-12-21');
});
test('inventory rejects invalid/duplicate/count-without-snapshot lines', () => {
  const input = { kind: 'receipt', items: [{ productId: 'sku1', quantity: 1 }] };
  assert.equal(validateInventoryDocument(input), input);
  for (const items of [[], [...input.items, ...input.items], [{ productId: 'sku1', quantity: -1 }], [{ productId: 'sku1', quantity: 0.00001 }]]) {
    assert.throws(() => validateInventoryDocument({ ...input, items }));
  }
  assert.throws(() => validateInventoryDocument({ kind: 'count', items: [{ productId: 'sku1', quantity: 0 }] }));
});
test('cache and request coalescing bound Cloud reads and force refresh respects pending work', async () => {
  let calls = 0; let time = 0; let finish;
  const gateway = createInventoryGateway({ scope: () => 'admin', now: () => time,
    rpc: async () => { calls++; await new Promise(resolve => { finish = resolve; }); return { rows: [] }; } });
  const first = gateway.read({ mode: 'stock' });
  const second = gateway.read({ mode: 'stock' }, { force: true });
  finish(); await Promise.all([first, second]);
  assert.equal(calls, 1);
  await gateway.read({ mode: 'stock' }); assert.equal(calls, 1);
  time = 60001; const next = gateway.read({ mode: 'stock' }); finish(); await next; assert.equal(calls, 2);
});
test('pending responses cannot enter the cache of another account', async () => {
  let actor = 'a'; let finish;
  const gateway = createInventoryGateway({ scope: () => actor,
    rpc: async () => { await new Promise(resolve => { finish = resolve; }); return { rows: [] }; } });
  const pending = gateway.read(); actor = 'b'; finish();
  await assert.rejects(pending, /Phiên/);
});
test('a 15-row request rejects an oversized Cloud response', async () => {
  const gateway = createInventoryGateway({ scope: () => 'admin', rpc: async () => ({ rows: Array.from({length:16}, () => ({})) }) });
  await assert.rejects(gateway.read({ mode:'stock', limit:15 }), /không hợp lệ/);
});
test('posting invalidates pages and preserves the supplied idempotency key', async () => {
  const calls = [];
  const gateway = createInventoryGateway({ scope: () => 'a', rpc: async (name, args) => { calls.push({name,args}); return name.endsWith('window') ? {rows:[]} : {id:'doc'}; } });
  await gateway.read(); await gateway.read();
  const input = { kind:'receipt', requestKey:'same-key', items:[{productId:'p', quantity:1}] };
  await gateway.post(input); await gateway.read();
  assert.equal(calls.length, 3);
  assert.equal(calls[1].args.p_input.requestKey, 'same-key');
});

test('sync toggles send explicit booleans and invalidate the cached control state', async () => {
  const calls = [];
  const gateway = createInventoryGateway({ scope: () => 'admin', rpc: async (name, args) => {
    calls.push({name,args}); return name.endsWith('window') ? {rows:[]} : {enabled:args.p_enabled};
  } });
  await gateway.read(); await gateway.read();
  await assert.rejects(gateway.setSync('false'), /không hợp lệ/);
  assert.equal(calls.length,1);
  await gateway.setSync(false); await gateway.read();
  await gateway.setSync(true,{acknowledgeOpening:true}); await gateway.read();
  assert.equal(calls.length,5);
  assert.deepEqual(calls[1],{name:'rpc_inventory_set_sync',args:{p_enabled:false,p_acknowledge_opening:false}});
  assert.deepEqual(calls[3].args,{p_enabled:true,p_acknowledge_opening:true});
});

test('a toggle response from a previous login cannot update the current session', async () => {
  let actor='first'; let finish;
  const gateway=createInventoryGateway({scope:()=>actor,rpc:async()=>{
    await new Promise(resolve=>{finish=resolve;}); return {enabled:false};
  }});
  const pending=gateway.setSync(false); actor='second'; finish();
  await assert.rejects(pending,/Phiên/);
});
