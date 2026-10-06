const crypto = require('crypto');
const { config } = require('./config');
const {
  loadReminders,
  saveReminders,
  withRemindersLock,
  updateState,
  normalizeArabicDigits,
  addDaysToDateKey,
  getNowParts,
  scheduleKey,
  loadState,
  saveState
} = require('./core');

function parseReminderCommand(commandText, now) {
  const normalized = normalizeArabicDigits(commandText.trim());
  const prefix = '/فكرني';

  if (!normalized.startsWith(prefix)) return null;

  let details = normalized.slice(prefix.length).trim();

  if (!details) {
    return { error: 'اكتب التذكير والوقت، مثال: /فكرني الساعة 5 أروح المشوار' };
  }

  let dayOffset = 0;

  if (/بعد\s+(بكرة|بُكرة|غد|غدا|غداً)/.test(details)) {
    dayOffset = 2;
  } else if (/بكرة|بُكرة|غدا|غداً/.test(details)) {
    dayOffset = 1;
  }

  const timeMatch = details.match(
    /(?:الساعة|ساعه)\s*([0-9]{1,2})(?::([0-9]{2}))?\s*(صباحًا|صباحا|مساءً|مساءا|ص|م)?/i
  );

  if (!timeMatch) {
    return {
      error:
        'مش لاقي الوقت 😅\nاستخدم مثلًا: /فكرني الساعة 5 أروح المشوار\nأو: /فكرني بكرة الساعة 8 أذاكر'
    };
  }

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] || 0);
  const meridiem = timeMatch[3] || '';

  if (hour > 23 || minute > 59) {
    return { error: 'الوقت ده مش صحيح 😅' };
  }

  if (meridiem) {
    const isPm = /م|مساء/.test(meridiem);
    const isAm = /ص|صباح/.test(meridiem);

    if (hour > 12 || (!isPm && !isAm)) {
      return { error: 'اكتب الساعة بين 1 و12 مع ص/م، أو استخدم 24 ساعة مثل 17:00.' };
    }

    if (isPm && hour < 12) hour += 12;
    if (isAm && hour === 12) hour = 0;
  } else if (hour >= 1 && hour <= 12) {
    if (dayOffset === 0) {
      const nowMinutes = now.hour * 60 + now.minute;

      const candidates = [hour, hour === 12 ? 0 : hour + 12]
        .filter((value) => value >= 0 && value <= 23)
        .sort((a, b) => {
          const aMinutes = a * 60 + minute;
          const bMinutes = b * 60 + minute;
          const aDelta = aMinutes >= nowMinutes ? aMinutes - nowMinutes : Infinity;
          const bDelta = bMinutes >= nowMinutes ? bMinutes - nowMinutes : Infinity;
          return aDelta - bDelta;
        });

      hour = candidates[0];
    } else {
      hour = hour === 12 ? 12 : hour;
    }
  }

  const targetDate = addDaysToDateKey(now.date, dayOffset);

  if (
    dayOffset === 0 &&
    (hour < now.hour || (hour === now.hour && minute <= now.minute))
  ) {
    return {
      error:
        'الساعة دي عدّت النهارده 😅\nقول مثلًا: /فكرني بكرة الساعة ' +
        timeMatch[1] +
        ' ' +
        details.replace(timeMatch[0], '').trim()
    };
  }

  const reminderText = details
    .replace(/بعد\s+(بكرة|بُكرة|غد|غدا|غداً)|بكرة|بُكرة|غدا|غداً/gi, '')
    .replace(timeMatch[0], '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!reminderText) {
    return {
      error: 'قولّي هفكرك بإيه 😅\nمثال: /فكرني الساعة 5 أروح المشوار'
    };
  }

  return {
    date: targetDate,
    time: String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'),
    text: reminderText
  };
}

async function createReminder(args) {
  return withRemindersLock(async () => {
    const {
      commandText,
      pushName,
      senderId,
      sourceMessageId,
      sendText
    } = args;

    const now = getNowParts(config.timezone);
  const parsed = parseReminderCommand(commandText, now);

  if (!parsed || parsed.error) {
    if (parsed?.error) await sendText('🤖 ' + parsed.error);
    return { created: false };
  }

  const reminders = loadReminders(config.remindersFile);

  if (
    sourceMessageId &&
    reminders.some((reminder) => reminder.sourceMessageId === sourceMessageId)
  ) {
    return { created: false, duplicate: true };
  }

  const reminder = {
    id: crypto.randomUUID(),
    sourceMessageId,
    senderName: String(pushName || 'أحد أفراد العيلة').trim(),
    senderId: String(senderId || ''),
    date: parsed.date,
    time: parsed.time,
    text: parsed.text,
    createdAt: new Date().toISOString()
  };

  reminders.push(reminder);
  saveReminders(config.remindersFile, reminders);

  await sendText(
    '✅ تمام يا ' +
      reminder.senderName +
      '، هفكرك يوم ' +
      reminder.date +
      ' الساعة ' +
      reminder.time +
      '.'
  );

    return { created: true, reminder };
  });
}

async function sendDueReminders(sendText) {
  return withRemindersLock(async () => {
  const now = getNowParts(config.timezone);
  const currentKey = scheduleKey(
    now.date,
    String(now.hour).padStart(2, '0') + ':' + String(now.minute).padStart(2, '0')
  );

  const reminders = loadReminders(config.remindersFile);
  let changed = false;

  for (const reminder of reminders) {
    const staleProcessing =
      reminder.processingAt &&
      Date.now() - Date.parse(reminder.processingAt) > 10 * 60 * 1000;

    const processing = reminder.processingAt && !staleProcessing;

    if (
      reminder.sentAt ||
      processing ||
      scheduleKey(reminder.date, reminder.time) > currentKey
    ) {
      continue;
    }

    reminder.processingAt = new Date().toISOString();
    saveReminders(config.remindersFile, reminders);

    try {
      await sendText(
        '🔔 تذكير لـ ' +
          reminder.senderName +
          '\n\n' +
          reminder.text
      );

      reminder.sentAt = new Date().toISOString();
      delete reminder.processingAt;
      changed = true;

      const quotes = require('fs').existsSync('./quotes.json')
        ? require('./core').loadJsonList('./quotes.json', 'quote')
        : [];
      await updateState(config.stateFile, quotes, (state) => {
        state.totalRemindersSent += 1;
        state.totalMessagesSent += 1;
      });
    } catch (error) {
      delete reminder.processingAt;
      changed = true;
      console.error('Reminder send failed:', error.message);
    }
  }

    if (changed) saveReminders(config.remindersFile, reminders);
  });
}

module.exports = {
  parseReminderCommand,
  createReminder,
  sendDueReminders
};
