const fs = require("fs");
const path = require("path");
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

function loadQuotes() {
  const quotes = JSON.parse(fs.readFileSync(quotesPath, "utf8"));
  if (!Array.isArray(quotes) || quotes.length === 0) {
    throw new Error("quotes.json must contain at least one quote.");
  }
  if (!quotes.every((q) => typeof q === "string" && q.trim().length > 0)) {
    throw new Error("Every quote in quotes.json must be a non-empty string.");
  }
  return quotes.map((q) => q.trim());
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      sent: Array.isArray(state.sent) ? state.sent : [],
      cycle: Number.isInteger(state.cycle) ? state.cycle : 1
    };
  } catch {
    return { sent: [], cycle: 1 };
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
  const sentSet = new Set(state.sent);
  const available = quotes
    .map((quote, index) => ({ quote, index }))
    .filter(({ index }) => !sentSet.has(index));

  if (available.length === 0) {
    state.sent = [];
    state.cycle += 1;
    saveState(state);
    return { quote: quotes[0], index: 0 };
  }

  return available[Math.floor(Math.random() * available.length)];
}

async function sendQuote() {
  const quotes = loadQuotes();
  const state = loadState();
  const selected = chooseQuote(quotes, state);
  const text = `💡 حكمة اليوم\n\n${selected.quote}`;

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
      })
    }
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Evolution API returned ${response.status}: ${responseText}`);
  }

  state.sent.push(selected.index);
  saveState(state);

  console.log(
    `[${new Date().toISOString()}] Quote #${selected.index + 1} sent successfully. Cycle: ${state.cycle}. Remaining: ${quotes.length - state.sent.length}`
  );
}

cron.schedule(SCHEDULE, async () => {
  try {
    await sendQuote();
  } catch (error) {
    console.error("Failed to send quote:", error);
  }
}, { timezone: TIMEZONE });

console.log("Daily WhatsApp Bot is running.");
console.log(`Instance: ${EVOLUTION_INSTANCE}`);
console.log(`Group: ${WHATSAPP_GROUP_ID}`);
console.log(`Schedule: ${SCHEDULE}`);
console.log(`Timezone: ${TIMEZONE}`);
console.log(`State file: ${STATE_FILE}`);
