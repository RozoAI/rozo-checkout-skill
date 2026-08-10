/**
 * How a deadline is shown to a human deciding whether they can make it.
 *
 * The order preview used to print an ISO 8601 timestamp in UTC plus a
 * "minutesOfSlack" number. Both are correct and neither answers the question
 * the user is actually asking, which is "do I have time to go and open my
 * wallet". Reported in a first-run UX review, 2026-08-09.
 *
 * `now` is injected throughout so these assertions do not depend on the clock,
 * and the timezone is pinned so the rendered local time is reproducible on any
 * machine and in CI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatDeadline } from '../scripts/src/lib/expiry.mjs';

const NOW = Date.parse('2026-08-09T14:00:00.000Z');
const OPTS = { now: NOW, locale: 'en-US', timeZone: 'UTC' };

test('renders remaining time and a wall-clock time, not an ISO string', () => {
  const got = formatDeadline('2026-08-09T14:58:00.000Z', OPTS);
  assert.equal(got, 'in about 58 minutes, at 2:58 PM local time');
  // The thing being replaced must not leak through.
  assert.doesNotMatch(got, /\d{4}-\d{2}-\d{2}T/, 'an ISO timestamp survived');
  assert.doesNotMatch(got, /slack/i);
});

test('singular minute is not rendered as "1 minutes"', () => {
  assert.equal(
    formatDeadline('2026-08-09T14:01:00.000Z', OPTS),
    'in about 1 minute, at 2:01 PM local time',
  );
});

test('under a minute does not round down to "0 minutes"', () => {
  // Math.round would give 0 here, which reads as "no time left" when there is
  // still half a minute to act.
  const got = formatDeadline('2026-08-09T14:00:20.000Z', OPTS);
  assert.equal(got, 'in less than a minute, at 2:00 PM local time');
});

test('over an hour switches to hours and minutes', () => {
  assert.equal(
    formatDeadline('2026-08-09T16:30:00.000Z', OPTS),
    'in about 2h 30m, at 4:30 PM local time',
  );
});

test('an elapsed deadline says so plainly rather than counting backwards', () => {
  assert.equal(formatDeadline('2026-08-09T13:59:00.000Z', OPTS), 'expired');
  assert.equal(formatDeadline('2026-08-09T14:00:00.000Z', OPTS), 'expired');
});

test('unusable input returns null so the caller can fall back', () => {
  // The caller prints the API's own expiresIn when this is null. Throwing here
  // would take down a payment preview over a formatting concern.
  assert.equal(formatDeadline(null, OPTS), null);
  assert.equal(formatDeadline(undefined, OPTS), null);
  assert.equal(formatDeadline('', OPTS), null);
  assert.equal(formatDeadline('not a date', OPTS), null);
});

test('the rendered clock time follows the viewer timezone, not UTC', () => {
  const iso = '2026-08-09T14:58:00.000Z';
  const utc = formatDeadline(iso, OPTS);
  const tokyo = formatDeadline(iso, { ...OPTS, timeZone: 'Asia/Tokyo' });
  assert.equal(utc, 'in about 58 minutes, at 2:58 PM local time');
  assert.equal(tokyo, 'in about 58 minutes, at 11:58 PM local time');
  // Same instant, same remaining time — only the wall clock differs.
  assert.ok(utc.startsWith('in about 58 minutes'));
  assert.ok(tokyo.startsWith('in about 58 minutes'));
});
