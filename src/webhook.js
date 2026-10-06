const crypto = require('crypto');
const { config } = require('./config');

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
    '';

  return {
    text: typeof text === 'string' ? text : '',
    key,
    pushName: messageData.pushName || data.pushName || payload.pushName || ''
  };
}

function isMessagesUpsert(payload) {
  const event = String(payload?.event || payload?.type || '')
    .toUpperCase()
    .replace(/[.\s-]+/g, '_');

  return event === 'MESSAGES_UPSERT';
}

function safeEqual(expected, actual) {
  const a = Buffer.from(expected || '');
  const b = Buffer.from(actual || '');

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAuthorizedWebhook(req) {
  if (!config.webhookSecret) return true;

  const header = req.headers['x-webhook-secret'];
  const auth = req.headers.authorization;
  const bearer =
    typeof auth === 'string' && auth.startsWith('Bearer ')
      ? auth.slice(7)
      : '';

  return safeEqual(
    config.webhookSecret,
    typeof header === 'string' ? header : bearer
  );
}

function createMessageDeduplicator({
  maxEntries = 5000,
  ttlMs = 15 * 60 * 1000
} = {}) {
  const entries = new Map();

  function prune(now) {
    for (const [id, timestamp] of entries) {
      if (now - timestamp >= ttlMs) {
        entries.delete(id);
      }
    }

    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    isDuplicate(messageId) {
      if (!messageId) return false;

      const now = Date.now();
      const previous = entries.get(messageId);

      if (previous !== undefined && now - previous < ttlMs) {
        return true;
      }

      entries.set(messageId, now);
      prune(now);
      return false;
    },

    forget(messageId) {
      if (messageId) entries.delete(messageId);
    }
  };
}

function createRateLimiter({ maxRequests, windowMs }) {
  const buckets = new Map();

  return {
    allow(key) {
      const now = Date.now();
      const current = buckets.get(key) || [];
      const fresh = current.filter(
        (timestamp) => now - timestamp < windowMs
      );

      if (fresh.length >= maxRequests) {
        buckets.set(key, fresh);
        return false;
      }

      fresh.push(now);
      buckets.set(key, fresh);

      if (buckets.size > 1000) {
        for (const [bucketKey, values] of buckets) {
          if (
            values.length === 0 ||
            now - values[values.length - 1] >= windowMs
          ) {
            buckets.delete(bucketKey);
          }
        }
      }

      return true;
    }
  };
}

module.exports = {
  extractWebhookMessage,
  isMessagesUpsert,
  safeEqual,
  isAuthorizedWebhook,
  createMessageDeduplicator,
  createRateLimiter
};
