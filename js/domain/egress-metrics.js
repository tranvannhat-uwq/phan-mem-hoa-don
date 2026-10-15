// Session-only HTTP measurements for Supabase JS. A snapshot contains route
// names and aggregate sizes, never URLs, query values, headers, or body data.
const DEFAULT_SAMPLE_BYTES = 256 * 1024;
const DEFAULT_MAX_ROUTES = 48;

function safeName(value, fallback = 'other') {
  return /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(value || '') ? value : fallback;
}

export function supabaseMetricRoute(input) {
  let pathname;
  try {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    pathname = new URL(raw).pathname;
  } catch (_error) {
    return '/other';
  }
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'rest' && parts[1] === 'v1') {
    if (parts[2] === 'rpc') return `/rest/v1/rpc/${safeName(parts[3])}`;
    return `/rest/v1/${safeName(parts[2])}`;
  }
  if (parts[0] === 'auth' && parts[1] === 'v1') {
    return `/auth/v1/${safeName(parts[2])}`;
  }
  if (parts[0] === 'storage' && parts[1] === 'v1') {
    // Bucket names and object keys can contain private customer details.
    return `/storage/v1/${safeName(parts[2])}/${safeName(parts[3])}`;
  }
  if (parts[0] === 'functions' && parts[1] === 'v1') {
    return `/functions/v1/${safeName(parts[2])}`;
  }
  if (parts[0] === 'realtime' && parts[1] === 'v1') return '/realtime/v1/http';
  return '/other';
}

function requestMethod(input, init) {
  const method = String(init?.method || input?.method || 'GET').toUpperCase();
  return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method) ? method : 'OTHER';
}

function numericContentLength(response) {
  const raw = response?.headers?.get?.('content-length');
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function sampleResponse(response, limit) {
  let copy;
  try {
    copy = response.clone();
  } catch (_error) {
    return { bytes: 0, truncated: false, measurementError: true };
  }
  if (!copy.body) return { bytes: 0, truncated: false, measurementError: false };

  const reader = copy.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return { bytes, truncated: false, measurementError: false };
      const chunkBytes = value?.byteLength || 0;
      if (bytes + chunkBytes > limit) {
        bytes = limit;
        // Do not await tee cancellation: its promise can wait for the caller's
        // original response branch to finish reading.
        void reader.cancel().catch(() => {});
        return { bytes, truncated: true, measurementError: false };
      }
      bytes += chunkBytes;
    }
  } catch (_error) {
    return { bytes, truncated: false, measurementError: true };
  }
}

function emptyCounter(endpoint, method) {
  return {
    endpoint, method, requests: 0, responses: 0, failures: 0,
    estimatedResponseBytes: 0, sampledResponseBytes: 0,
    truncatedResponses: 0, headerSizedResponses: 0,
    measurementErrors: 0, elapsedMs: 0
  };
}

/**
 * Pass `meter.fetch` as Supabase's `global.fetch` option. `snapshot()` is a
 * local, bounded summary; `flush()` waits for response sampling before taking
 * a baseline. WebSocket traffic and browser/CDN requests are outside scope.
 */
export function createEgressMeter({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = () => Date.now(),
  maxSampleBytes = DEFAULT_SAMPLE_BYTES,
  maxRoutes = DEFAULT_MAX_ROUTES
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (!Number.isInteger(maxSampleBytes) || maxSampleBytes < 1 || maxSampleBytes > 1024 * 1024) {
    throw new RangeError('maxSampleBytes must be between 1 byte and 1 MiB.');
  }
  if (!Number.isInteger(maxRoutes) || maxRoutes < 1 || maxRoutes > 256) {
    throw new RangeError('maxRoutes must be between 1 and 256.');
  }

  let counters = new Map();
  let generation = 0;
  const pending = new Set();

  function counterFor(input, init) {
    const endpoint = supabaseMetricRoute(input);
    const method = requestMethod(input, init);
    const key = `${method} ${endpoint}`;
    if (counters.has(key)) return counters.get(key);
    if (counters.size >= maxRoutes) {
      const overflow = counters.get('OTHER /overflow');
      if (overflow) return overflow;
      // Make room for a single overflow counter while staying within the cap.
      const lastKey = [...counters.keys()].at(-1);
      const last = counters.get(lastKey);
      counters.delete(lastKey);
      const bucket = emptyCounter('/overflow', 'OTHER');
      for (const field of Object.keys(bucket)) {
        if (typeof bucket[field] === 'number') bucket[field] += last[field];
      }
      counters.set('OTHER /overflow', bucket);
      return bucket;
    }
    const counter = emptyCounter(endpoint, method);
    counters.set(key, counter);
    return counter;
  }

  async function measuredFetch(input, init) {
    const requestGeneration = generation;
    const start = now();
    const counter = counterFor(input, init);
    counter.requests += 1;
    let response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      if (requestGeneration === generation) {
        counter.failures += 1;
        counter.elapsedMs += Math.max(0, now() - start);
      }
      throw error;
    }
    if (requestGeneration !== generation) return response;
    counter.responses += 1;
    counter.elapsedMs += Math.max(0, now() - start);
    if (!response.ok) counter.failures += 1;
    const headerBytes = numericContentLength(response);
    const measurement = sampleResponse(response, maxSampleBytes).then(sample => {
      if (requestGeneration !== generation) return;
      counter.sampledResponseBytes += sample.bytes;
      counter.estimatedResponseBytes += headerBytes ?? sample.bytes;
      if (headerBytes !== null) counter.headerSizedResponses += 1;
      if (sample.truncated) counter.truncatedResponses += 1;
      if (sample.measurementError) counter.measurementErrors += 1;
    });
    pending.add(measurement);
    void measurement.finally(() => pending.delete(measurement)).catch(() => {});
    return response;
  }

  return {
    fetch: measuredFetch,
    async flush() { await Promise.allSettled([...pending]); },
    reset() { generation += 1; counters = new Map(); },
    snapshot() {
      const routes = [...counters.values()].map(counter => ({ ...counter }))
        .sort((a, b) => b.estimatedResponseBytes - a.estimatedResponseBytes || b.requests - a.requests);
      const totals = emptyCounter('all', 'ALL');
      for (const counter of routes) {
        for (const field of Object.keys(totals)) {
          if (typeof totals[field] === 'number') totals[field] += counter[field];
        }
      }
      return { totals, routes, pendingMeasurements: pending.size };
    }
  };
}
