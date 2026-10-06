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
  updateState,
  textHash
} = require('../src/core');
const { parseReminderCommand } = require('../src/reminders');
const {
  safeEqual,
  createMessageDeduplicator,
  createRateLimiter
} = require('../src/webhook');

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


test('state updates are serialized without losing increments', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-bot-state-lock-'));
  const stateFile = path.join(dir, 'state.json');
  const quotes = ['one', 'two'];

  await Promise.all([
    updateState(stateFile, quotes, async (state) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state.totalMessagesSent += 1;
    }),
    updateState(stateFile, quotes, async (state) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      state.totalMessagesSent += 1;
    })
  ]);

  const finalState = loadState(stateFile, quotes);
  assert.equal(finalState.totalMessagesSent, 2);
});

test('webhook deduplicator ignores repeated message IDs', () => {
  const dedupe = createMessageDeduplicator({ maxEntries: 10, ttlMs: 60_000 });

  assert.equal(dedupe.isDuplicate('msg-1'), false);
  assert.equal(dedupe.isDuplicate('msg-1'), true);
  assert.equal(dedupe.isDuplicate('msg-2'), false);

  dedupe.forget('msg-1');
  assert.equal(dedupe.isDuplicate('msg-1'), false);
});
