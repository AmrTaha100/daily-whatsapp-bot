const fs = require("fs");
const cron = require("node-cron");

const EVOLUTION_URL = (process.env.EVOLUTION_URL || "").replace(/\/$/, "");
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "daily-bot";
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID;
const SCHEDULE = process.env.SCHEDULE || "0 15 * * *";
const TIMEZONE = process.env.TIMEZONE || "Africa/Cairo";

if (!EVOLUTION_URL || !EVOLUTION_API_KEY || !WHATSAPP_GROUP_ID) {
  console.error("Missing required environment variables:");
  if (!EVOLUTION_URL) console.error("- EVOLUTION_URL");
  if (!EVOLUTION_API_KEY) console.error("- EVOLUTION_API_KEY");
  if (!WHATSAPP_GROUP_ID) console.error("- WHATSAPP_GROUP_ID");
  process.exit(1);
}

const quotesPath = "./quotes.json";
const statePath = "./state.json";

function loadQuotes() {
  const raw = fs.readFileSync(quotesPath, "utf8");
  const quotes = JSON.parse(raw);

  if (!Array.isArray(quotes) || quotes.length === 0) {
    throw new Error("quotes.json must contain at least one quote.");
  }

  if (!quotes.every((q) => typeof q === "string" && q.trim().length > 0)) {
    throw new Error("Every quote in quotes.json must be a non-empty string.");
  }

  return quotes;
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      nextIndex: Number.isInteger(state.nextIndex) ? state.nextIndex : 0
    };
  } catch {
    return { nextIndex: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

async function sendQuote() {
  const quotes = loadQuotes();
  const state = loadState();
  const index = state.nextIndex % quotes.length;
  const quote = quotes[index];

  const text = `💡 حكمة اليوم\n\n${quote}`;

  const response = await fetch(
    `${EVOLUTION_URL}/message/sendText/${encodeURIComponent(EVOLUTION_INSTANCE)}`,
    {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "apikey": EVOLUTION_API_KEY
      },
      body: JSON.stringify({
        number: WHATSAPP_GROUP_ID,
        text
      })
    }
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Evolution API returned ${response.status}: ${responseText}`);
  }

  state.nextIndex = (index + 1) % quotes.length;
  saveState(state);

  console.log(`[${new Date().toISOString()}] Quote #${index + 1} sent successfully.`);
  console.log(responseText);
}

cron.schedule(
  SCHEDULE,
  async () => {
    try {
      await sendQuote();
    } catch (error) {
      console.error("Failed to send quote:", error);
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
