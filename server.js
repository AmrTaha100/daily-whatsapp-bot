const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cron = require("node-cron");

const EVOLUTION_URL = (process.env.EVOLUTION_URL || "").replace(/\/$/, "");
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "daily-bot";
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID;
const SCHEDULE = process.env.SCHEDULE || "0 15 * * *";
const TIMEZONE = process.env.TIMEZONE || "Africa/Cairo";
const STATE_FILE = process.env.STATE_FILE || "/data/state.json";

if (!EVOLUTION_URL || !EVOLUTION_API_KEY || !WHATSAPP_GROUP_ID) {
  console.error("Missing required environment variables:");
  if (!EVOLUTION_URL) console.error("- EVOLUTION_URL");
  if (!EVOLUTION_API_KEY) console.error("- EVOLUTION_API_KEY");
  if (!WHATSAPP_GROUP_ID) console.error("- WHATSAPP_GROUP_ID");
  process.exit(1);
}

const quotesPath = path.resolve("./quotes.json");
let sending = false;

function loadQuotes() {
  const quotes = JSON.parse(fs.readFileSync(quotesPath, "utf8"));

  if (!Array.isArray(quotes) || quotes.length === 0) {
    throw new Error("quotes.json must contain at least one quote.");
  }

  if (!quotes.every((q) => typeof q === "string" && q.trim().length > 0)) {
    throw new Error("Every quote in quotes.json must be a non-empty string.");
  }

  const cleaned = quotes.map((q) => q.trim());
  const unique = new Set(cleaned);

  if (unique.size !== cleaned.length) {
    throw new Error("quotes.json contains duplicate quote text. Remove duplicates.");
  }

  return cleaned;
}

function quoteHash(quote) {
  return crypto.createHash("sha256").update(quote, "utf8").digest("hex");
}

function loadState(quotes) {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

    if (Array.isArray(state.sentHashes)) {
      return {
        sentHashes: [...new Set(state.sentHashes.filter((v) => typeof v === "string"))],
        cycle: Number.isInteger(state.cycle) && state.cycle > 0 ? state.cycle : 1
      };
    }

    // Backward compatibility with the previous index-based state format.
    if (Array.isArray(state.sent)) {
      const sentHashes = state.sent
        .filter((index) => Number.isInteger(index) && index >= 0 && index < quotes.length)
        .map((index) => quoteHash(quotes[index]));

      return {
        sentHashes: [...new Set(sentHashes)],
        cycle: Number.isInteger(state.cycle) && state.cycle > 0 ? state.cycle : 1
      };
    }

    return { sentHashes: [], cycle: 1 };
  } catch {
    return { sentHashes: [], cycle: 1 };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  fs.mkdirSync(dir, { recursive: true });

  const tempFile = STATE_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tempFile, STATE_FILE);
}

function chooseQuote(quotes, state) {
  const sentSet = new Set(state.sentHashes);

  const available = quotes
    .map((quote, index) => ({
      quote,
      index,
      hash: quoteHash(quote)
    }))
    .filter(({ hash }) => !sentSet.has(hash));

  if (available.length === 0) {
    state.sentHashes = [];
    state.cycle += 1;
    saveState(state);
    return {
      quote: quotes[0],
      index: 0,
      hash: quoteHash(quotes[0])
    };
  }

  return available[Math.floor(Math.random() * available.length)];
}

async function sendQuote() {
  const quotes = loadQuotes();
  const state = loadState(quotes);
  const selected = chooseQuote(quotes, state);

  const text = `💡 حكمة اليوم\n\n${selected.quote}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(
      `${EVOLUTION_URL}/message/sendText/${encodeURIComponent(EVOLUTION_INSTANCE)}`,
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
      throw new Error(
        `Evolution API returned ${response.status}: ${responseText}`
      );
    }

    // Only mark a quote as sent after Evolution API confirms acceptance.
    state.sentHashes.push(selected.hash);
    state.sentHashes = [...new Set(state.sentHashes)];
    saveState(state);

    console.log(
      `[${new Date().toISOString()}] Quote sent successfully. ` +
      `Cycle: ${state.cycle}. Remaining: ${quotes.length - state.sentHashes.length}`
    );
    console.log(`Evolution response: ${responseText}`);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Evolution API request timed out after 30 seconds.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

cron.schedule(
  SCHEDULE,
  async () => {
    if (sending) {
      console.warn("A previous send is still running; skipping this scheduled run.");
      return;
    }

    sending = true;

    try {
      await sendQuote();
    } catch (error) {
      console.error("Failed to send quote:", error);
    } finally {
      sending = false;
    }
  },
  {
    timezone: TIMEZONE
  }
);

console.log("Daily WhatsApp Bot is running.");
console.log(`Instance: ${EVOLUTION_INSTANCE}`);
console.log(`Group: ${WHATSAPP_GROUP_ID}`);
console.log(`Schedule: ${SCHEDULE}`);
console.log(`Timezone: ${TIMEZONE}`);
console.log(`State file: ${STATE_FILE}`);
