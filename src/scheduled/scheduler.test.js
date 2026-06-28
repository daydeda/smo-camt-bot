import test from 'node:test';
import assert from 'node:assert/strict';
import { getZonedParts, shouldRunDaily, shouldRunWeekly } from './scheduler.js';

test('getZonedParts converts to the target timezone wall clock', () => {
  // 02:30 UTC == 09:30 in Asia/Bangkok (UTC+7).
  const parts = getZonedParts(new Date('2026-06-28T02:30:00Z'), 'Asia/Bangkok');
  assert.equal(parts.dateKey, '2026-06-28');
  assert.equal(parts.minutes, 9 * 60 + 30);
});

test('getZonedParts normalizes midnight to 0 minutes and rolls the date', () => {
  // 17:00 UTC == 00:00 next day in Asia/Bangkok.
  const parts = getZonedParts(new Date('2026-06-27T17:00:00Z'), 'Asia/Bangkok');
  assert.equal(parts.dateKey, '2026-06-28');
  assert.equal(parts.minutes, 0);
});

test('shouldRunDaily fires once at/after the scheduled time', () => {
  const time = { hour: 9, minute: 0 };
  assert.equal(shouldRunDaily({ dateKey: 'd1', minutes: 540 }, time, null), true);
  assert.equal(shouldRunDaily({ dateKey: 'd1', minutes: 600 }, time, null), true);
  // Already ran today.
  assert.equal(shouldRunDaily({ dateKey: 'd1', minutes: 600 }, time, 'd1'), false);
  // Before scheduled time.
  assert.equal(shouldRunDaily({ dateKey: 'd1', minutes: 480 }, time, null), false);
  // No schedule configured.
  assert.equal(shouldRunDaily({ dateKey: 'd1', minutes: 600 }, null, null), false);
});

test('shouldRunWeekly only fires on the target weekday', () => {
  const time = { hour: 8, minute: 30 };
  assert.equal(shouldRunWeekly({ dateKey: 'd1', minutes: 520, weekday: 1 }, time, 1, null), true);
  assert.equal(shouldRunWeekly({ dateKey: 'd1', minutes: 520, weekday: 2 }, time, 1, null), false);
  assert.equal(shouldRunWeekly({ dateKey: 'd1', minutes: 520, weekday: 1 }, time, 1, 'd1'), false);
});
