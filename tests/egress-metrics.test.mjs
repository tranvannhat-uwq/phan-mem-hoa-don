import assert from 'node:assert/strict';
import test from 'node:test';
import { createEgressMeter, supabaseMetricRoute } from '../js/domain/egress-metrics.js';

test('groups Supabase paths without retaining query values, IDs or object keys', () => {
  assert.equal(supabaseMetricRoute('https://project.supabase.co/rest/v1/orders?select=*&customer_email=private@example.com'), '/rest/v1/orders');
  assert.equal(supabaseMetricRoute('https://project.supabase.co/rest/v1/rpc/rpc_get_cashbook_window?token=secret'), '/rest/v1/rpc/rpc_get_cashbook_window');
  assert.equal(supabaseMetricRoute('https://project.supabase.co/storage/v1/object/public/customer-files/account-123/invoice.pdf'), '/storage/v1/object/public');
  assert.equal(supabaseMetricRoute('https://project.supabase.co/auth/v1/admin/users/private-id'), '/auth/v1/admin');
  assert.equal(supabaseMetricRoute('https://project.supabase.co/functions/v1/admin-create-user'), '/functions/v1/admin-create-user');
  assert.equal(supabaseMetricRoute('invalid URL'), '/other');
});

test('counts HTTP requests and UTF-8 response bytes without another fetch or consuming the caller response', async () => {
  let calls = 0;
  const meter = createEgressMeter({ fetchImpl: async () => {
    calls += 1;
    return new Response(JSON.stringify({ name: 'Bình' }), { status: 200 });
  } });
  const first = await meter.fetch('https://project.supabase.co/rest/v1/customers?id=eq.private-123', {
    headers: { Authorization: 'Bearer secret-token' }
  });
  const expectedBody = await first.text();
  const second = await meter.fetch('https://project.supabase.co/rest/v1/customers?id=eq.private-456');
  assert.equal(await second.text(), expectedBody);
  await meter.flush();

  const snapshot = meter.snapshot();
  assert.equal(calls, 2);
  assert.equal(snapshot.totals.requests, 2);
  assert.equal(snapshot.totals.responses, 2);
  assert.equal(snapshot.totals.estimatedResponseBytes, Buffer.byteLength(expectedBody) * 2);
  assert.equal(snapshot.routes.length, 1);
  assert.equal(snapshot.routes[0].endpoint, '/rest/v1/customers');
  assert.doesNotMatch(JSON.stringify(snapshot), /private-123|private-456|secret-token|Bình/);
});

test('caps sampling of large responses and reports a lower bound when Content-Length is absent', async () => {
  const meter = createEgressMeter({
    maxSampleBytes: 4,
    fetchImpl: async () => new Response('abcdefghij', { status: 200 })
  });
  const response = await meter.fetch('https://project.supabase.co/rest/v1/orders?select=*');
  assert.equal(await response.text(), 'abcdefghij');
  await meter.flush();
  const { totals } = meter.snapshot();
  assert.equal(totals.sampledResponseBytes, 4);
  assert.equal(totals.estimatedResponseBytes, 4);
  assert.equal(totals.truncatedResponses, 1);
  assert.equal(totals.headerSizedResponses, 0);
});

test('uses Content-Length as a declared byte estimate and records HTTP and network failures', async () => {
  let attempts = 0;
  const meter = createEgressMeter({
    maxSampleBytes: 4,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 2) throw new Error('network offline');
      return new Response('abcdefghij', { status: 503, headers: { 'Content-Length': '10' } });
    }
  });
  const response = await meter.fetch('https://project.supabase.co/rest/v1/orders', { method: 'POST' });
  assert.equal(response.status, 503);
  await assert.rejects(meter.fetch('https://project.supabase.co/rest/v1/orders', { method: 'POST' }), /network offline/);
  await meter.flush();
  const { totals, routes } = meter.snapshot();
  assert.equal(attempts, 2);
  assert.equal(totals.requests, 2);
  assert.equal(totals.responses, 1);
  assert.equal(totals.failures, 2);
  assert.equal(totals.estimatedResponseBytes, 10);
  assert.equal(totals.sampledResponseBytes, 4);
  assert.equal(totals.truncatedResponses, 1);
  assert.equal(totals.headerSizedResponses, 1);
  assert.equal(routes[0].method, 'POST');
});

test('reset discards pending measurements from a previous account and keeps endpoint memory bounded', async () => {
  let resolveFetch;
  const meter = createEgressMeter({
    maxRoutes: 2,
    fetchImpl: () => new Promise(resolve => { resolveFetch = resolve; })
  });
  const pending = meter.fetch('https://project.supabase.co/rest/v1/orders');
  meter.reset();
  resolveFetch(new Response('old account'));
  assert.equal(await (await pending).text(), 'old account');
  await meter.flush();
  assert.equal(meter.snapshot().totals.requests, 0);

  // The route summary retains at most maxRoutes buckets including overflow.
  for (const table of ['customers', 'products', 'invoices', 'orders']) {
    const request = meter.fetch(`https://project.supabase.co/rest/v1/${table}`);
    resolveFetch(new Response('ok'));
    await request;
  }
  await meter.flush();
  const snapshot = meter.snapshot();
  assert.equal(snapshot.totals.requests, 4);
  assert.ok(snapshot.routes.length <= 2);
  assert.ok(snapshot.routes.some(route => route.endpoint === '/overflow'));
});
