const http = require('http');
const cron = require('node-cron');
const { config, validateConfig } = require('./src/config');
const { loadJsonList, loadState, saveState } = require('./src/core');
const {
  sendText,
  handleAskCommand,
  sendWeather,
  sendFact,
  sendQuote
} = require('./src/services');
const { createReminder, sendDueReminders } = require('./src/reminders');
const {
  extractWebhookMessage,
  isMessagesUpsert,
  isAuthorizedWebhook,
  createRateLimiter
} = require('./src/webhook');

const missing = validateConfig();

if (missing.length) {
  console.error('Missing required environment variables:');
  for (const name of missing) console.error('- ' + name);
  process.exit(1);
}

const path = require('path');
const quotesPath = path.resolve('./quotes.json');
const startedAt = new Date().toISOString();
const inboundLimiter = createRateLimiter({ maxRequests: 30, windowMs: 60_000 });
const taskLocks = new Set();

function initializeState() {
  const quotes = loadJsonList(quotesPath, 'quote');
  const state = loadState(config.stateFile, quotes);

  if (!state.startedAt) {
    state.startedAt = startedAt;
    saveState(config.stateFile, state);
  }
}

function updateCommandStats(command, ask = false) {
  const quotes = loadJsonList(quotesPath, 'quote');
  const state = loadState(config.stateFile, quotes);
  state.commandCounts[command] = (state.commandCounts[command] || 0) + 1;
  if (ask) state.totalAskRequests += 1;
  saveState(config.stateFile, state);
}

async function handleIncomingWebhook(payload) {
  if (!isMessagesUpsert(payload)) return;

  const instance = payload?.instance || payload?.instanceName;
  if (instance && instance !== config.evolutionInstance) return;

  const { text, key, pushName } = extractWebhookMessage(payload);

  if (key.fromMe === true) return;
  if (key.remoteJid !== config.whatsappGroupId) return;

  const senderId = String(key.participant || key.remoteJid || 'unknown');

  if (!inboundLimiter.allow(senderId)) {
    console.warn('Inbound rate limit reached for ' + senderId + '.');
    return;
  }

  const commandText = text.trim();

  if (/^\/(?:اسأل|اسال)(?:\s|$)/.test(commandText)) {
    updateCommandStats('/اسأل', true);
    const answer = await handleAskCommand(commandText, senderId);
    await sendText(answer);
    return;
  }

  if (commandText.startsWith('/فكرني')) {
    updateCommandStats('/فكرني');
    await createReminder({
      commandText,
      pushName,
      senderId,
      sourceMessageId: typeof key.id === 'string' ? key.id : null,
      sendText
    });
  }
}

async function runTask(label, task) {
  if (taskLocks.has(label)) {
    console.warn(label + ': previous run is still active; skipping this run.');
    return;
  }

  taskLocks.add(label);

  try {
    await task();
  } catch (error) {
    console.error(label + ' failed:', error.message);

    try {
      const quotes = loadJsonList(quotesPath, 'quote');
      const state = loadState(config.stateFile, quotes);
      state.lastErrorAt = new Date().toISOString();
      saveState(config.stateFile, state);
    } catch (stateError) {
      console.error('Could not persist error state:', stateError.message);
    }
  } finally {
    taskLocks.delete(label);
  }
}

function handleHttpRequest(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', service: config.evolutionInstance }));
    return;
  }

  const requestUrl = new URL(req.url, 'http://localhost');

  if (requestUrl.pathname !== config.webhookPath || req.method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  if (!isAuthorizedWebhook(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false }));
    return;
  }

  let body = '';
  let tooLarge = false;

  req.setEncoding('utf8');

  req.on('data', (chunk) => {
    if (tooLarge) return;

    body += chunk;

    if (Buffer.byteLength(body, 'utf8') > config.webhookMaxBodyBytes) {
      tooLarge = true;
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'payload_too_large' }));
      req.destroy();
    }
  });

  req.on('end', async () => {
    if (tooLarge || res.writableEnded) return;

    try {
      const payload = JSON.parse(body);
      await handleIncomingWebhook(payload);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      console.error('Webhook handling failed:', error.message);
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false }));
    }
  });
}

initializeState();

const server = http.createServer(handleHttpRequest);

server.listen(config.port, '0.0.0.0', () => {
  console.log('HTTP server listening on port ' + config.port);
});

cron.schedule(
  config.weatherSchedule,
  () => runTask('Weather', sendWeather),
  { timezone: config.timezone }
);

cron.schedule(
  '* * * * *',
  () => runTask('Reminders', () => sendDueReminders(sendText)),
  { timezone: config.timezone }
);

cron.schedule(
  config.factSchedule,
  () => runTask('Fact', sendFact),
  { timezone: config.timezone }
);

cron.schedule(
  config.schedule,
  () => runTask('Quote', sendQuote),
  { timezone: config.timezone }
);

console.log('Daily WhatsApp Bot is running.');
console.log('Instance: ' + config.evolutionInstance);
console.log('Group: ' + config.whatsappGroupId);
console.log('Weather schedule: ' + config.weatherSchedule);
console.log('Fact schedule: ' + config.factSchedule);
console.log('Quote schedule: ' + config.schedule);
console.log('Reminder webhook: ' + config.webhookPath);
console.log('Reminder check: every minute');
console.log('Gemini: ' + (config.geminiApiKey ? 'configured' : 'not configured'));
console.log('Gemini model: ' + config.geminiModel);
console.log('Webhook auth: ' + (config.webhookSecret ? 'enabled' : 'disabled (set WEBHOOK_SECRET to enable)'));
console.log('Timezone: ' + config.timezone);
