/**
 * HTTP client: the User-Agent carries the real package version, and a 429 (or
 * a 503 with Retry-After) is retried a bounded number of times within a total
 * wait budget, never forever. fetch and sleep are mocked; nothing waits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  getJson,
  postJson,
  parseRetryAfter,
  USER_AGENT,
  MAX_RETRIES,
  MAX_TOTAL_WAIT_MS,
} from '../scripts/src/lib/http.mjs';

const pkg = createRequire(import.meta.url)('../package.json');

function reply(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Swap global fetch for a scripted sequence of responses; records calls. */
async function withFetch(responses, fn) {
  const calls = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof next === 'function' ? next() : next.clone();
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function recorder() {
  const waits = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
}

test('User-Agent is rozo-checkout-skill/<package version>', async () => {
  assert.equal(USER_AGENT, `rozo-checkout-skill/${pkg.version}`);
  assert.notEqual(pkg.version, '0.0.0');
  await withFetch([reply(200, { ok: true })], async (calls) => {
    await getJson('https://example.test/x');
    assert.equal(calls[0].init.headers['user-agent'], `rozo-checkout-skill/${pkg.version}`);
  });
});

test('parseRetryAfter: delta-seconds, HTTP-date, past date, garbage', () => {
  const now = Date.parse('2026-10-10T00:00:00Z');
  assert.equal(parseRetryAfter('30', now), 30_000);
  assert.equal(parseRetryAfter(' 0 ', now), 0);
  assert.equal(parseRetryAfter('Sat, 10 Oct 2026 00:00:45 GMT', now), 45_000);
  assert.equal(parseRetryAfter('Fri, 09 Oct 2026 23:00:00 GMT', now), 0);
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter('', now), null);
});

test('429 with Retry-After: sleeps the server value, then succeeds', async () => {
  const { waits, sleep } = recorder();
  await withFetch(
    [reply(429, { code: 'RATE_LIMITED' }, { 'retry-after': '7' }), reply(200, { ok: 1 })],
    async (calls) => {
      const json = await getJson('https://example.test/x', { sleep });
      assert.deepEqual(json, { ok: 1 });
      assert.equal(calls.length, 2);
    },
  );
  assert.deepEqual(waits, [7_000]);
});

test('429 falls back to body retryAfterSeconds when the header is absent', async () => {
  const { waits, sleep } = recorder();
  await withFetch(
    [reply(429, { code: 'RATE_LIMITED', retryAfterSeconds: 3 }), reply(200, { ok: 1 })],
    async () => {
      await postJson('https://example.test/x', { a: 1 }, { sleep });
    },
  );
  assert.deepEqual(waits, [3_000]);
});

test('429 without any hint uses short exponential backoff', async () => {
  const { waits, sleep } = recorder();
  await withFetch(
    [reply(429, {}), reply(429, {}), reply(200, { ok: 1 })],
    async () => {
      await getJson('https://example.test/x', { sleep });
    },
  );
  assert.deepEqual(waits, [2_000, 4_000]);
});

test('persistent 429: exactly MAX_RETRIES retries, then the existing error path', async () => {
  const { waits, sleep } = recorder();
  await withFetch(
    [
      reply(
        429,
        { code: 'RATE_LIMITED', message: 'slow down' },
        {
          'retry-after': '1',
          'x-ratelimit-limit': '30',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-tier': 'anon',
          'x-ratelimit-scope': 'ip',
        },
      ),
    ],
    async (calls) => {
      await assert.rejects(
        getJson('https://example.test/x?secret=1', { sleep }),
        (err) => {
          assert.equal(err.code, 'RATE_LIMITED');
          assert.equal(err.message, 'slow down');
          assert.equal(err.details.httpStatus, 429);
          assert.equal(err.details.url, 'https://example.test/x');
          assert.equal(err.details.retries, MAX_RETRIES);
          assert.equal(err.details.retryAfterSeconds, 1);
          assert.deepEqual(err.details.rateLimit, {
            limit: '30',
            remaining: '0',
            tier: 'anon',
            scope: 'ip',
          });
          return true;
        },
      );
      assert.equal(calls.length, MAX_RETRIES + 1);
    },
  );
  assert.deepEqual(waits, [1_000, 1_000, 1_000]);
});

test('a wait beyond the total budget is not slept: fail at once with the server value', async () => {
  const { waits, sleep } = recorder();
  await withFetch([reply(429, { code: 'RATE_LIMITED' }, { 'retry-after': '3600' })], async (calls) => {
    await assert.rejects(getJson('https://example.test/x', { sleep }), (err) => {
      assert.equal(err.code, 'RATE_LIMITED');
      assert.equal(err.details.retries, 0);
      assert.equal(err.details.retryAfterSeconds, 3600);
      assert.equal(err.details.rateLimit, undefined);
      return true;
    });
    assert.equal(calls.length, 1);
  });
  assert.deepEqual(waits, []);
});

test('the sum of waits never exceeds MAX_TOTAL_WAIT_MS', async () => {
  const { waits, sleep } = recorder();
  // 50s each: two fit in 120s, the third would make 150s and is refused.
  await withFetch([reply(429, {}, { 'retry-after': '50' })], async (calls) => {
    await assert.rejects(getJson('https://example.test/x', { sleep }), (err) => err.details.retries === 2);
    assert.equal(calls.length, 3);
  });
  assert.deepEqual(waits, [50_000, 50_000]);
  assert.ok(waits.reduce((a, b) => a + b, 0) <= MAX_TOTAL_WAIT_MS);
});

test('503 is retried only when it carries Retry-After', async () => {
  const a = recorder();
  await withFetch([reply(503, {}, { 'retry-after': '2' }), reply(200, { ok: 1 })], async () => {
    await getJson('https://example.test/x', { sleep: a.sleep });
  });
  assert.deepEqual(a.waits, [2_000]);

  const b = recorder();
  await withFetch([reply(503, { code: 'DOWN' })], async (calls) => {
    await assert.rejects(getJson('https://example.test/x', { sleep: b.sleep }), (err) => {
      assert.equal(err.code, 'DOWN');
      assert.equal(err.details.retries, undefined);
      return true;
    });
    assert.equal(calls.length, 1);
  });
  assert.deepEqual(b.waits, []);
});

test('other statuses are unchanged: no retry, same error shape', async () => {
  const { waits, sleep } = recorder();
  for (const status of [400, 409, 500, 502]) {
    await withFetch([reply(status, { code: 'X_FAIL', message: 'nope' })], async (calls) => {
      await assert.rejects(getJson('https://example.test/x', { sleep }), (err) => {
        assert.equal(err.code, 'X_FAIL');
        assert.deepEqual(Object.keys(err.details).sort(), ['body', 'httpStatus', 'url']);
        return true;
      });
      assert.equal(calls.length, 1);
    });
  }
  assert.deepEqual(waits, []);
});
