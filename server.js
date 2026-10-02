const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cron = require("node-cron");

const EVOLUTION_URL = (process.env.EVOLUTION_URL || "").replace(/\/$/, "");
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "daily-bot";
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID;

const SCHEDULE = process.env.SCHEDULE || "0 15 * * *";
const WEATHER_SCHEDULE = process.env.WEATHER_SCHEDULE || "0 0 * * *";
const FACT_SCHEDULE = process.env.FACT_SCHEDULE || "0 8 * * *";
const TIMEZONE = process.env.TIMEZONE || "Africa/Cairo";
const STATE_FILE = process.env.STATE_FILE || "/data/state.json";

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

cron.schedule(
  WEATHER_SCHEDULE,
  () => runTask("Weather", sendWeather),
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
console.log("Timezone: " + TIMEZONE);
console.log(
  "Weather locations: " +
    WEATHER_LOCATION + " (" + WEATHER_LATITUDE + ", " + WEATHER_LONGITUDE + ") + " +
    RIYADH_LOCATION + " (" + RIYADH_LATITUDE + ", " + RIYADH_LONGITUDE + ")"
);
