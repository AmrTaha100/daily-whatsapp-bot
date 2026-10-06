const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadJsonList(filePath, label) {
  const items = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(label + ' file must contain at least one item.');
  }

  if (!items.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    throw new Error('Every ' + label + ' must be a non-empty string.');
  }

  const cleaned = items.map((item) => item.trim());

  if (new Set(cleaned).size !== cleaned.length) {
    throw new Error(label + ' file contains duplicate text. Remove duplicates.');
  }

  return cleaned;
}

function textHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tempFile = filePath + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempFile, filePath);
}

function loadState(stateFile, quotes = []) {
  const state = readJson(stateFile, {});

  let sentHashes = [];

  if (Array.isArray(state.sentHashes)) {
    sentHashes = [...new Set(state.sentHashes.filter((value) => typeof value === 'string'))];
  } else if (Array.isArray(state.sent) && quotes.length > 0) {
    sentHashes = [...new Set(
      state.sent
        .filter((index) => Number.isInteger(index) && index >= 0 && index < quotes.length)
        .map((index) => textHash(quotes[index]))
    )];
  }

  return {
    sentHashes,
    cycle: Number.isInteger(state.cycle) && state.cycle > 0 ? state.cycle : 1,
    factSentHashes: Array.isArray(state.factSentHashes)
      ? [...new Set(state.factSentHashes.filter((value) => typeof value === 'string'))]
      : [],
    factCycle: Number.isInteger(state.factCycle) && state.factCycle > 0 ? state.factCycle : 1,
    lastQuoteDate: typeof state.lastQuoteDate === 'string' ? state.lastQuoteDate : null,
    lastFactDate: typeof state.lastFactDate === 'string' ? state.lastFactDate : null,
    lastWeatherDate: typeof state.lastWeatherDate === 'string' ? state.lastWeatherDate : null,
    totalMessagesSent: Number.isInteger(state.totalMessagesSent) && state.totalMessagesSent >= 0 ? state.totalMessagesSent : 0,
    totalWeatherSent: Number.isInteger(state.totalWeatherSent) && state.totalWeatherSent >= 0 ? state.totalWeatherSent : 0,
    totalFactsSent: Number.isInteger(state.totalFactsSent) && state.totalFactsSent >= 0 ? state.totalFactsSent : 0,
    totalQuotesSent: Number.isInteger(state.totalQuotesSent) && state.totalQuotesSent >= 0 ? state.totalQuotesSent : 0,
    totalRemindersSent: Number.isInteger(state.totalRemindersSent) && state.totalRemindersSent >= 0 ? state.totalRemindersSent : 0,
    totalAskRequests: Number.isInteger(state.totalAskRequests) && state.totalAskRequests >= 0 ? state.totalAskRequests : 0,
    commandCounts: state.commandCounts && typeof state.commandCounts === 'object' ? state.commandCounts : {},
    startedAt: typeof state.startedAt === 'string' ? state.startedAt : null,
    lastErrorAt: typeof state.lastErrorAt === 'string' ? state.lastErrorAt : null
  };
}

function saveState(stateFile, state) {
  writeJsonAtomic(stateFile, state);
}

function chooseRandomItem(items, state, hashesKey, cycleKey) {
  const sentSet = new Set(state[hashesKey]);

  const available = items
    .map((item) => ({ item, hash: textHash(item) }))
    .filter(({ hash }) => !sentSet.has(hash));

  if (available.length === 0) {
    state[hashesKey] = [];
    state[cycleKey] += 1;

    const item = items[Math.floor(Math.random() * items.length)];
    return { item, hash: textHash(item) };
  }

  return available[Math.floor(Math.random() * available.length)];
}

function loadReminders(filePath) {
  const reminders = readJson(filePath, []);

  if (!Array.isArray(reminders)) return [];

  return reminders.filter((reminder) => {
    return reminder &&
      typeof reminder.id === 'string' &&
      typeof reminder.date === 'string' &&
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(reminder.date) &&
      typeof reminder.time === 'string' &&
      /^[0-9]{2}:[0-9]{2}$/.test(reminder.time) &&
      typeof reminder.text === 'string' &&
      reminder.text.trim().length > 0 &&
      typeof reminder.senderName === 'string';
  });
}

function saveReminders(filePath, reminders) {
  writeJsonAtomic(filePath, reminders);
}

function normalizeArabicDigits(value) {
  return value
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}

function getDateParts(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date())
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day)
  };
}

function toDateKey(parts) {
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0')
  ].join('-');
}

function getNowParts(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date())
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value])
  );

  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));

  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function formatArabicDate(dateKey) {
  const date = new Date(dateKey + 'T12:00:00Z');

  return new Intl.DateTimeFormat('ar-EG', {
    timeZone: 'Africa/Cairo',
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  }).format(date);
}

function scheduleKey(date, time) {
  return date + 'T' + time;
}

module.exports = {
  loadJsonList,
  textHash,
  readJson,
  writeJsonAtomic,
  loadState,
  saveState,
  chooseRandomItem,
  loadReminders,
  saveReminders,
  normalizeArabicDigits,
  getDateParts,
  toDateKey,
  getNowParts,
  addDaysToDateKey,
  formatArabicDate,
  scheduleKey
};
