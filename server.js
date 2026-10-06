const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const cron = require("node-cron");
const { GoogleGenAI } = require("@google/genai");

const EVOLUTION_URL = (process.env.EVOLUTION_URL || "").replace(/\/$/, "");
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "daily-bot";
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID;

const SCHEDULE = process.env.SCHEDULE || "0 15 * * *";
const WEATHER_SCHEDULE = process.env.WEATHER_SCHEDULE || "0 0 * * *";
const FACT_SCHEDULE = process.env.FACT_SCHEDULE || "0 8 * * *";
const TIMEZONE = process.env.TIMEZONE || "Africa/Cairo";
const STATE_FILE = process.env.STATE_FILE || "/data/state.json";
const REMINDERS_FILE = process.env.REMINDERS_FILE || "/data/reminders.json";
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhook";
const PORT = Number(process.env.PORT) || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const WEATHER_LOCATION = "قرية شنشا";
const WEATHER_LATITUDE = 30.882654;
const WEATHER_LONGITUDE = 31.320136;

const RIYADH_LOCATION = "الرياض";
const RIYADH_LATITUDE = 24.7136;
const RIYADH_LONGITUDE = 46.6753;

if (!EVOLUTION_URL || !EVOLUTION_API_KEY || !WHATSAPP_GROUP_ID) {
  console.error("Missing required environment variables:");
  if (!EVOLUTION_URL) console.error("- EVOLUTION_URL");
  if (!EVOLUTION_API_KEY) console.error("- EVOLUTION_API_KEY");
  if (!WHATSAPP_GROUP_ID) console.error("- WHATSAPP_GROUP_ID");
  process.exit(1);
}

const quotesPath = path.resolve("./quotes.json");
const factsPath = path.resolve("./facts.json");
let sending = false;

function loadJsonList(filePath, label) {
  const items = JSON.parse(fs.readFileSync(filePath, "utf8"));

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(label + " file must contain at least one item.");
  }

  if (!items.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error("Every " + label + " must be a non-empty string.");
  }

  const cleaned = items.map((item) => item.trim());
  const unique = new Set(cleaned);

  if (unique.size !== cleaned.length) {
    throw new Error(label + " file contains duplicate text. Remove duplicates.");
  }

  return cleaned;
}

function loadQuotes() {
  return loadJsonList(quotesPath, "quote");
}

function loadFacts() {
  return loadJsonList(factsPath, "fact");
}

function textHash(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function loadState(quotes) {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

    let sentHashes = [];
    if (Array.isArray(state.sentHashes)) {
      sentHashes = [...new Set(state.sentHashes.filter((value) => typeof value === "string"))];
    } else if (Array.isArray(state.sent)) {
      sentHashes = [
        ...new Set(
          state.sent
            .filter((index) => Number.isInteger(index) && index >= 0 && index < quotes.length)
            .map((index) => textHash(quotes[index]))
        )
      ];
    }

    return {
      sentHashes,
      cycle: Number.isInteger(state.cycle) && state.cycle > 0 ? state.cycle : 1,
      factSentHashes: Array.isArray(state.factSentHashes)
        ? [...new Set(state.factSentHashes.filter((value) => typeof value === "string"))]
        : [],
      factCycle: Number.isInteger(state.factCycle) && state.factCycle > 0 ? state.factCycle : 1,
      lastQuoteDate: typeof state.lastQuoteDate === "string" ? state.lastQuoteDate : null,
      lastFactDate: typeof state.lastFactDate === "string" ? state.lastFactDate : null,
      lastWeatherDate: typeof state.lastWeatherDate === "string" ? state.lastWeatherDate : null
    };
  } catch {
    return {
      sentHashes: [],
      cycle: 1,
      factSentHashes: [],
      factCycle: 1,
      lastQuoteDate: null,
      lastFactDate: null,
      lastWeatherDate: null
    };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  fs.mkdirSync(dir, { recursive: true });

  const tempFile = STATE_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tempFile, STATE_FILE);
}

function chooseRandomItem(items, state, hashesKey, cycleKey) {
  const sentSet = new Set(state[hashesKey]);

  const available = items
    .map((item) => ({ item, hash: textHash(item) }))
    .filter(({ hash }) => !sentSet.has(hash));

  if (available.length === 0) {
    state[hashesKey] = [];
    state[cycleKey] += 1;
    saveState(state);
    const item = items[Math.floor(Math.random() * items.length)];
    return { item, hash: textHash(item) };
  }

  return available[Math.floor(Math.random() * available.length)];
}

async function sendText(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(
      EVOLUTION_URL + "/message/sendText/" + encodeURIComponent(EVOLUTION_INSTANCE),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8",
          apikey: EVOLUTION_API_KEY
        },
        body: JSON.stringify({
          number: WHATSAPP_GROUP_ID,
          text
        }),
        signal: controller.signal
      }
    );

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error("Evolution API returned " + response.status + ": " + responseText);
    }

    return responseText;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Evolution API request timed out after 30 seconds.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getDateParts(timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date())
      .filter(({ type }) => type !== "literal")
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
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0")
  ].join("-");
}

function formatArabicDate(dateKey) {
  const date = new Date(dateKey + "T12:00:00Z");

  return new Intl.DateTimeFormat("ar-EG", {
    timeZone: "Africa/Cairo",
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(date);
}

function weatherDescription(code) {
  const descriptions = {
    0: "☀️ صافٍ",
    1: "🌤️ غالبًا صافٍ",
    2: "⛅ غائم جزئيًا",
    3: "☁️ غائم",
    45: "🌫️ ضباب",
    48: "🌫️ ضباب متجمد",
    51: "🌦️ رذاذ خفيف",
    53: "🌦️ رذاذ متوسط",
    55: "🌧️ رذاذ كثيف",
    56: "🌧️ رذاذ متجمد خفيف",
    57: "🌧️ رذاذ متجمد كثيف",
    61: "🌧️ أمطار خفيفة",
    63: "🌧️ أمطار متوسطة",
    65: "🌧️ أمطار غزيرة",
    66: "🌧️ أمطار متجمدة خفيفة",
    67: "🌧️ أمطار متجمدة غزيرة",
    71: "🌨️ ثلوج خفيفة",
    73: "🌨️ ثلوج متوسطة",
    75: "❄️ ثلوج غزيرة",
    77: "❄️ حبيبات ثلجية",
    80: "🌦️ زخات مطر خفيفة",
    81: "🌦️ زخات مطر متوسطة",
    82: "⛈️ زخات مطر غزيرة",
    85: "🌨️ زخات ثلج خفيفة",
    86: "❄️ زخات ثلج غزيرة",
    95: "⛈️ عواصف رعدية",
    96: "⛈️ عواصف رعدية مع برد",
    99: "⛈️ عواصف رعدية مع برد شديد"
  };

  return descriptions[code] || "🌤️ حالة جوية غير محددة";
}

async function fetchWeather(location, targetDate) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");

  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,weather_code"
  );
  url.searchParams.set("timezone", location.timezone);
  url.searchParams.set("forecast_days", "3");
  url.searchParams.set("temperature_unit", "celsius");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(30_000)
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error("Open-Meteo returned " + response.status + ": " + responseText);
  }

  const data = JSON.parse(responseText);

  if (
    !data.daily ||
    !Array.isArray(data.daily.time) ||
    !Array.isArray(data.daily.temperature_2m_max) ||
    !Array.isArray(data.daily.temperature_2m_min) ||
    !Array.isArray(data.daily.weather_code)
  ) {
    throw new Error("Open-Meteo returned an incomplete forecast for " + location.name + ".");
  }

  const index = data.daily.time.indexOf(targetDate);

  if (index === -1) {
    throw new Error("Forecast date " + targetDate + " was not returned for " + location.name + ".");
  }

  return {
    name: location.name,
    min: Math.round(data.daily.temperature_2m_min[index]),
    max: Math.round(data.daily.temperature_2m_max[index]),
    code: data.daily.weather_code[index]
  };
}

async function fetchWeatherWithRetry(location, targetDate) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchWeather(location, targetDate);
    } catch (error) {
      lastError = error;

      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
      }
    }
  }

  throw lastError;
}

async function sendWeather() {
  const state = loadState(loadQuotes());
  const shanashaDate = toDateKey(getDateParts("Africa/Cairo"));
  const riyadhDate = toDateKey(getDateParts("Asia/Riyadh"));

  if (state.lastWeatherDate === shanashaDate) {
    console.log("Weather for " + shanashaDate + " already sent; skipping duplicate run.");
    return;
  }

  const [shanasha, riyadh] = await Promise.all([
    fetchWeatherWithRetry(
      {
        name: WEATHER_LOCATION,
        latitude: WEATHER_LATITUDE,
        longitude: WEATHER_LONGITUDE,
        timezone: "Africa/Cairo"
      },
      shanashaDate
    ),
    fetchWeatherWithRetry(
      {
        name: RIYADH_LOCATION,
        latitude: RIYADH_LATITUDE,
        longitude: RIYADH_LONGITUDE,
        timezone: "Asia/Riyadh"
      },
      riyadhDate
    )
  ]);

  const dateLabel = formatArabicDate(shanashaDate);

  const text = [
    "🌤️ طقس اليوم — " + dateLabel,
    "",
    "📍 " + shanasha.name,
    "🌡️ الحرارة: " + shanasha.min + "° - " + shanasha.max + "°",
    weatherDescription(shanasha.code),
    "",
    "━━━━━━━━━━━━",
    "",
    "📍 " + riyadh.name,
    "🌡️ الحرارة: " + riyadh.min + "° - " + riyadh.max + "°",
    weatherDescription(riyadh.code)
  ].join("\n");

  const responseText = await sendText(text);

  state.lastWeatherDate = shanashaDate;
  saveState(state);

  console.log("[" + new Date().toISOString() + "] Weather sent for " + shanashaDate + ".");
  console.log("Evolution response: " + responseText);
}

async function sendFact() {
  const facts = loadFacts();
  const state = loadState(loadQuotes());
  const today = toDateKey(getDateParts("Africa/Cairo"));

  if (state.lastFactDate === today) {
    console.log("Fact for " + today + " already sent; skipping duplicate run.");
    return;
  }

  const selected = chooseRandomItem(
    facts,
    state,
    "factSentHashes",
    "factCycle"
  );

  const text = "🧠 معلومة اليوم\n\n" + selected.item;
  const responseText = await sendText(text);

  state.factSentHashes.push(selected.hash);
  state.factSentHashes = [...new Set(state.factSentHashes)];
  state.lastFactDate = today;
  saveState(state);

  console.log(
    "[" + new Date().toISOString() + "] Fact sent successfully. " +
      "Cycle: " + state.factCycle + ". Remaining: " +
      (facts.length - state.factSentHashes.length)
  );
  console.log("Evolution response: " + responseText);
}

async function sendQuote() {
  const quotes = loadQuotes();
  const state = loadState(quotes);
  const today = toDateKey(getDateParts("Africa/Cairo"));

  if (state.lastQuoteDate === today) {
    console.log("Quote for " + today + " already sent; skipping duplicate run.");
    return;
  }

  const selected = chooseRandomItem(
    quotes,
    state,
    "sentHashes",
    "cycle"
  );

  const text = "💡 حكمة اليوم\n\n" + selected.item;
  const responseText = await sendText(text);

  state.sentHashes.push(selected.hash);
  state.sentHashes = [...new Set(state.sentHashes)];
  state.lastQuoteDate = today;
  saveState(state);

  console.log(
    "[" + new Date().toISOString() + "] Quote sent successfully. " +
      "Cycle: " + state.cycle + ". Remaining: " +
      (quotes.length - state.sentHashes.length)
  );
  console.log("Evolution response: " + responseText);
}

async function runTask(label, task) {
  if (sending) {
    console.warn(label + ": another send is still running; skipping this run.");
    return;
  }

  sending = true;

  try {
    await task();
  } catch (error) {
    console.error(label + " failed:", error);
  } finally {
    sending = false;
  }
}


let geminiClient = null;

function getGeminiClient() {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }

  return geminiClient;
}

async function askGemini(question) {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: question,
    config: {
      systemInstruction:
        "أنت مساعد ذكي داخل بوت واتساب عائلي مصري. أجب بالعربية الواضحة وبأسلوب ودود ومختصر قدر الإمكان. لا تدّعي معلومات غير مؤكدة، وإذا كان السؤال يحتاج معلومات حديثة فاذكر أن معلوماتك قد تحتاج إلى تحقق خارجي. لا تستخدم تحية طويلة أو مقدمات زائدة.",
    }
  });

  const answer = typeof response.text === "string" ? response.text.trim() : "";

  if (!answer) {
    throw new Error("Gemini returned an empty response.");
  }

  return answer;
}

async function handleAskCommand(commandText) {
  const match = commandText.match(/^\\/(?:اسأل|اسال)(?:\\s+([\\s\\S]+))?$/);

  if (!match || !match[1] || !match[1].trim()) {
    return "🤖 اكتب سؤالك بعد الأمر، مثال:\n/اسأل ليه السماء لونها أزرق؟";
  }

  try {
    const answer = await askGemini(match[1].trim());
    return "🤖 " + answer;
  } catch (error) {
    console.error("Gemini request failed:", error);

    if (error?.message === "GEMINI_API_KEY is not configured.") {
      return "⚠️ Gemini مش متفعل حاليًا. محتاج إضافة GEMINI_API_KEY في إعدادات البوت.";
    }

    return "⚠️ حصلت مشكلة وأنا بحاول أسأل Gemini. جرّب تاني بعد شوية.";
  }
}

function loadReminders() {
  try {
    const reminders = JSON.parse(fs.readFileSync(REMINDERS_FILE, "utf8"));

    if (!Array.isArray(reminders)) {
      throw new Error("Reminders file must contain an array.");
    }

    return reminders.filter((reminder) => {
      return (
        reminder &&
        typeof reminder.id === "string" &&
        typeof reminder.date === "string" &&
        /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(reminder.date) &&
        typeof reminder.time === "string" &&
        /^[0-9]{2}:[0-9]{2}$/.test(reminder.time) &&
        typeof reminder.text === "string" &&
        reminder.text.trim().length > 0 &&
        typeof reminder.senderName === "string"
      );
    });
  } catch {
    return [];
  }
}

function saveReminders(reminders) {
  const dir = path.dirname(REMINDERS_FILE);
  fs.mkdirSync(dir, { recursive: true });

  const tempFile = REMINDERS_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(reminders, null, 2), "utf8");
  fs.renameSync(tempFile, REMINDERS_FILE);
}

function normalizeArabicDigits(value) {
  return value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}

function getNowParts(timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date())
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value])
  );

  return {
    date: parts.year + "-" + parts.month + "-" + parts.day,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));

  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function extractWebhookMessage(payload) {
  const data = payload?.data || {};
  const messageData = Array.isArray(data.messages) ? data.messages[0] || {} : data;
  const key = messageData.key || data.key || {};

  const message = messageData.message || data.message || {};
  const text =
    message.conversation ||
    message.extendedTextMessage?.text ||
    messageData.text?.body ||
    data.text?.body ||
    messageData.body ||
    data.body ||
    "";

  return {
    text: typeof text === "string" ? text : "",
    key,
    pushName: messageData.pushName || data.pushName || payload.pushName || ""
  };
}

function isMessagesUpsert(payload) {
  const event = String(payload?.event || payload?.type || "")
    .toUpperCase()
    .replace(/[.\s-]+/g, "_");

  return event === "MESSAGES_UPSERT";
}

function parseReminderCommand(commandText, now) {
  const normalized = normalizeArabicDigits(commandText.trim());
  const prefix = "/فكرني";

  if (!normalized.startsWith(prefix)) {
    return null;
  }

  let details = normalized.slice(prefix.length).trim();

  if (!details) {
    return { error: "اكتب التذكير والوقت، مثال: /فكرني الساعة 5 أروح المشوار" };
  }

  let dayOffset = 0;
  const hasDayKeyword = /بعد\s+(بكرة|بُكرة|غد|غدا|غداً)|بكرة|بُكرة|غدا|غداً/.test(details);

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
        "مش لاقي الوقت 😅\nاستخدم مثلًا: /فكرني الساعة 5 أروح المشوار\nأو: /فكرني بكرة الساعة 8 أذاكر"
    };
  }

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] || 0);
  const meridiem = timeMatch[3] || "";

  if (hour > 23 || minute > 59) {
    return { error: "الوقت ده مش صحيح 😅" };
  }

  if (meridiem) {
    const isPm = /م|مساء/.test(meridiem);
    const isAm = /ص|صباح/.test(meridiem);

    if (hour > 12 || (!isPm && !isAm)) {
      return { error: "اكتب الساعة بين 1 و12 مع ص/م، أو استخدم 24 ساعة مثل 17:00." };
    }

    if (isPm && hour < 12) hour += 12;
    if (isAm && hour === 12) hour = 0;
  } else if (hour >= 1 && hour <= 12) {
    if (dayOffset === 0) {
      const candidates = [hour, hour === 12 ? 0 : hour + 12]
        .filter((value) => value >= 0 && value <= 23)
        .sort((a, b) => {
          const aMinutes = a * 60 + minute;
          const bMinutes = b * 60 + minute;
          const nowMinutes = now.hour * 60 + now.minute;

          const aDelta = aMinutes >= nowMinutes ? aMinutes - nowMinutes : Infinity;
          const bDelta = bMinutes >= nowMinutes ? bMinutes - nowMinutes : Infinity;

          return aDelta - bDelta;
        });

      hour = candidates[0];
    } else if (hour >= 1 && hour <= 12) {
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
        "الساعة دي عدّت النهارده 😅\nقول مثلًا: /فكرني بكرة الساعة " +
        timeMatch[1] +
        " " +
        details.replace(timeMatch[0], "").trim()
    };
  }

  const reminderText = details
    .replace(/بعد\s+(بكرة|بُكرة|غد|غدا|غداً)|بكرة|بُكرة|غدا|غداً/gi, "")
    .replace(timeMatch[0], "")
    .replace(/\s+/g, " ")
    .trim();

  if (!reminderText) {
    return {
      error: "قولّي هفكرك بإيه 😅\nمثال: /فكرني الساعة 5 أروح المشوار"
    };
  }

  return {
    date: targetDate,
    time:
      String(hour).padStart(2, "0") +
      ":" +
      String(minute).padStart(2, "0"),
    text: reminderText,
    hasDayKeyword
  };
}

async function handleIncomingWebhook(payload) {
  if (!isMessagesUpsert(payload)) return;

  const instance = payload?.instance || payload?.instanceName;
  if (instance && instance !== EVOLUTION_INSTANCE) return;

  const { text, key, pushName } = extractWebhookMessage(payload);

  if (key.fromMe === true) return;
  if (key.remoteJid !== WHATSAPP_GROUP_ID) return;

  const commandText = text.trim();

  if (commandText === "/اسأل" || commandText === "/اسال" || commandText.startsWith("/اسأل ") || commandText.startsWith("/اسال ")) {
    await sendText(await handleAskCommand(commandText));
    return;
  }

  if (!commandText.startsWith("/فكرني")) return;

  const now = getNowParts(TIMEZONE);
  const parsed = parseReminderCommand(commandText, now);

  if (!parsed || parsed.error) {
    await sendText("🤖 " + parsed.error);
    return;
  }

  const reminders = loadReminders();
  const sourceMessageId = typeof key.id === "string" ? key.id : null;

  if (sourceMessageId && reminders.some((reminder) => reminder.sourceMessageId === sourceMessageId)) {
    return;
  }

  const reminder = {
    id: crypto.randomUUID(),
    sourceMessageId,
    senderName: String(pushName || "أحد أفراد العيلة").trim(),
    senderId: String(key.participant || key.remoteJid || ""),
    date: parsed.date,
    time: parsed.time,
    text: parsed.text,
    createdAt: new Date().toISOString()
  };

  reminders.push(reminder);
  saveReminders(reminders);

  await sendText(
    "✅ تمام يا " +
      reminder.senderName +
      "، هفكرك يوم " +
      reminder.date +
      " الساعة " +
      reminder.time +
      "."
  );

  console.log(
    "[" +
      new Date().toISOString() +
      "] Reminder created for " +
      reminder.senderName +
      " at " +
      reminder.date +
      " " +
      reminder.time +
      "."
  );
}

async function sendDueReminders() {
  const now = getNowParts(TIMEZONE);
  const reminders = loadReminders();

  const due = reminders.filter(
    (reminder) =>
      !reminder.sentAt &&
      reminder.date === now.date &&
      reminder.time ===
        String(now.hour).padStart(2, "0") +
          ":" +
          String(now.minute).padStart(2, "0")
  );

  if (due.length === 0) return;

  for (const reminder of due) {
    try {
      await sendText(
        "🔔 تذكير لـ " +
          reminder.senderName +
          "\n\n" +
          reminder.text
      );
      reminder.sentAt = new Date().toISOString();
      console.log(
        "[" +
          new Date().toISOString() +
          "] Reminder sent to " +
          reminder.senderName +
          ": " +
          reminder.date +
          " " +
          reminder.time
      );
    } catch (error) {
      console.error("Reminder send failed:", error);
    }
  }

  saveReminders(reminders);
}

async function handleHttpRequest(req, res) {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  const requestUrl = new URL(req.url, "http://localhost");

  if (requestUrl.pathname !== WEBHOOK_PATH || req.method !== "POST") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  let body = "";

  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;

    if (body.length > 1_000_000) {
      req.destroy();
    }
  });

  req.on("end", async () => {
    try {
      const payload = JSON.parse(body);
      await handleIncomingWebhook(payload);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      console.error("Webhook handling failed:", error);
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false }));
    }
  });

  req.on("error", (error) => {
    console.error("Webhook request error:", error);
  });
}

const httpServer = http.createServer(handleHttpRequest);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("HTTP server listening on port " + PORT);
});

cron.schedule(
  WEATHER_SCHEDULE,
  () => runTask("Weather", sendWeather),
  { timezone: TIMEZONE }
);

cron.schedule(
  "* * * * *",
  () => runTask("Reminders", sendDueReminders),
  { timezone: TIMEZONE }
);

cron.schedule(
  FACT_SCHEDULE,
  () => runTask("Fact", sendFact),
  { timezone: TIMEZONE }
);

cron.schedule(
  SCHEDULE,
  () => runTask("Quote", sendQuote),
  { timezone: TIMEZONE }
);

console.log("Daily WhatsApp Bot is running.");
console.log("Instance: " + EVOLUTION_INSTANCE);
console.log("Group: " + WHATSAPP_GROUP_ID);
console.log("Weather schedule: " + WEATHER_SCHEDULE);
console.log("Fact schedule: " + FACT_SCHEDULE);
console.log("Quote schedule: " + SCHEDULE);
console.log("Reminder webhook: " + WEBHOOK_PATH);
console.log("Reminder check: every minute");
console.log("Gemini: " + (GEMINI_API_KEY ? "configured" : "not configured"));
console.log("Gemini model: " + GEMINI_MODEL);
console.log("Timezone: " + TIMEZONE);
console.log(
  "Weather locations: " +
    WEATHER_LOCATION + " (" + WEATHER_LATITUDE + ", " + WEATHER_LONGITUDE + ") + " +
    RIYADH_LOCATION + " (" + RIYADH_LATITUDE + ", " + RIYADH_LONGITUDE + ")"
);
