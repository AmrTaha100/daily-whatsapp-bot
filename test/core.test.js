const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  addDaysToDateKey,
  scheduleKey,
  normalizeArabicDigits,
  loadState,
  textHash
} = require('../src/core');
const { parseReminderCommand } = require('../src/reminders');
const { safeEqual, createRateLimiter } = require('../src/webhook');

test('reminder uses the next 9 o’clock when AM/PM is omitted', () => {
  assert.equal(
    parseReminderCommand(
      '/فكرني الساعة 9 أروح المشوار',
      { date: '2026-10-06', hour: 8, minute: 0 }
    ).time,
    '09:00'
  );

  assert.equal(
    parseReminderCommand(
      '/فكرني الساعة 9 أروح المشوار',
      { date: '2026-10-06', hour: 20, minute: 0 }
    ).time,
    '21:00'
  );
});

test('reminder honors explicit AM/PM', () => {
  const now = { date: '2026-10-06', hour: 8, minute: 0 };

  assert.equal(
    parseReminderCommand('/فكرني الساعة 9 مساء أروح المشوار', now).time,
    '21:00'
  );

  assert.equal(
    parseReminderCommand('/فكرني الساعة 9 صباحا أروح المشوار', now).time,
    '09:00'
  );
});

test('reminder tomorrow keeps 9 AM for ambiguous time, preserving current behavior', () => {
  const result = parseReminderCommand(
    '/فكرني بكرة الساعة 9 أروح المشوار',
    { date: '2026-10-06', hour: 20, minute: 0 }
  );

  assert.deepEqual(result, {
    date: '2026-10-07',
    time: '09:00',
    text: 'أروح المشوار'
  });
});

test('date helpers handle month boundaries', () => {
  assert.equal(addDaysToDateKey('2026-10-31', 1), '2026-11-01');
  assert.equal(
    scheduleKey('2026-10-07', '09:00') <
      scheduleKey('2026-10-07', '10:00'),
    true
  );
});

test('Arabic digits normalize correctly', () => {
  assert.equal(normalizeArabicDigits('الساعة ٩:٠٥'), 'الساعة 9:05');
});

test('legacy quote indexes migrate to hashes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-bot-test-'));
  const stateFile = path.join(dir, 'state.json');

  fs.writeFileSync(
    stateFile,
    JSON.stringify({ sent: [1] }),
    'utf8'
  );

  const quotes = ['one', 'two', 'three'];
  const state = loadState(stateFile, quotes);

  assert.deepEqual(state.sentHashes, [textHash('two')]);
});

test('webhook secret comparison is exact', () => {
  assert.equal(safeEqual('secret', 'secret'), true);
  assert.equal(safeEqual('secret', 'Secret'), false);
  assert.equal(safeEqual('secret', 'secret2'), false);
});

test('rate limiter blocks only after the configured count', () => {
  const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });

  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), false);
  assert.equal(limiter.allow('b'), true);
});
