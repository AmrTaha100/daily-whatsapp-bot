const config = {
  evolutionUrl: (process.env.EVOLUTION_URL || '').replace(/\/$/, ''),
  evolutionApiKey: process.env.EVOLUTION_API_KEY || '',
  evolutionInstance: process.env.EVOLUTION_INSTANCE || 'daily-bot',
  whatsappGroupId: process.env.WHATSAPP_GROUP_ID || '',
  schedule: process.env.SCHEDULE || '0 15 * * *',
  weatherSchedule: process.env.WEATHER_SCHEDULE || '0 0 * * *',
  factSchedule: process.env.FACT_SCHEDULE || '0 8 * * *',
  timezone: process.env.TIMEZONE || 'Africa/Cairo',
  stateFile: process.env.STATE_FILE || '/data/state.json',
  remindersFile: process.env.REMINDERS_FILE || '/data/reminders.json',
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  webhookMaxBodyBytes: Number(process.env.WEBHOOK_MAX_BODY_BYTES) || 1_000_000,
  port: Number(process.env.PORT) || 8080,
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  geminiMaxQuestionChars: Number(process.env.GEMINI_MAX_QUESTION_CHARS) || 2_000,
  geminiMaxRequests: Number(process.env.GEMINI_MAX_REQUESTS) || 5,
  geminiRateWindowMs: Number(process.env.GEMINI_RATE_WINDOW_MS) || 10 * 60 * 1000
};

function validateConfig() {
  const missing = [];

  if (!config.evolutionUrl) missing.push('EVOLUTION_URL');
  if (!config.evolutionApiKey) missing.push('EVOLUTION_API_KEY');
  if (!config.whatsappGroupId) missing.push('WHATSAPP_GROUP_ID');

  return missing;
}

module.exports = { config, validateConfig };
