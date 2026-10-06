const { GoogleGenAI } = require('@google/genai');
const path = require('path');
const { config } = require('./config');
const {
  getDateParts,
  toDateKey,
  formatArabicDate,
  loadJsonList,
  loadState,
  saveState,
  updateState,
  chooseRandomItem
} = require('./core');

let geminiClient = null;

const WEATHER_LOCATION = 'قرية شنشا';
const WEATHER_LATITUDE = 30.882654;
const WEATHER_LONGITUDE = 31.320136;
const RIYADH_LOCATION = 'الرياض';
const RIYADH_LATITUDE = 24.7136;
const RIYADH_LONGITUDE = 46.6753;

const quotesPath = path.resolve('./quotes.json');
const factsPath = path.resolve('./facts.json');

async function sendText(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(
      config.evolutionUrl + '/message/sendText/' + encodeURIComponent(config.evolutionInstance),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json; charset=utf-8',
          apikey: config.evolutionApiKey
        },
        body: JSON.stringify({
          number: config.whatsappGroupId,
          text
        }),
        signal: controller.signal
      }
    );

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error('Evolution API returned ' + response.status + ': ' + responseText);
    }

    return responseText;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Evolution API request timed out after 30 seconds.');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getGeminiClient() {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }

  return geminiClient;
}

function checkGeminiRateLimit(senderId) {
  const now = Date.now();
  const key = senderId || 'unknown';

  if (!checkGeminiRateLimit.buckets) {
    checkGeminiRateLimit.buckets = new Map();
  }

  const bucket = checkGeminiRateLimit.buckets.get(key) || [];
  const fresh = bucket.filter((timestamp) => now - timestamp < config.geminiRateWindowMs);

  if (fresh.length >= config.geminiMaxRequests) {
    checkGeminiRateLimit.buckets.set(key, fresh);
    return false;
  }

  fresh.push(now);
  checkGeminiRateLimit.buckets.set(key, fresh);

  if (checkGeminiRateLimit.buckets.size > 1000) {
    for (const [bucketKey, values] of checkGeminiRateLimit.buckets) {
      if (values.length === 0 || now - values[values.length - 1] >= config.geminiRateWindowMs) {
        checkGeminiRateLimit.buckets.delete(bucketKey);
      }
    }
  }

  return true;
}

async function askGemini(question) {
  if (question.length > config.geminiMaxQuestionChars) {
    throw new Error('QUESTION_TOO_LONG:' + config.geminiMaxQuestionChars);
  }

  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: config.geminiModel,
    contents: question,
    config: {
      systemInstruction:
        'أنت مساعد ذكي داخل بوت واتساب عائلي مصري. أجب بالعربية الواضحة وبأسلوب ودود ومختصر قدر الإمكان. لا تدّعي معلومات غير مؤكدة، ولا تطلب أو تكشف بيانات شخصية، ولا تتعامل مع رسائل الجروب العادية؛ أنت تجيب فقط عن السؤال الذي أرسله المستخدم بعد أمر /اسأل.'
    }
  });

  const answer = typeof response.text === 'string' ? response.text.trim() : '';

  if (!answer) {
    throw new Error('Gemini returned an empty response.');
  }

  return answer;
}

async function handleAskCommand(commandText, senderId) {
  const match = commandText.match(/^\/(?:اسأل|اسال)(?:\s+([\s\S]+))?$/);

  if (!match || !match[1] || !match[1].trim()) {
    return '🤖 اكتب سؤالك بعد الأمر، مثال:\n/اسأل ليه السماء لونها أزرق؟';
  }

  if (!checkGeminiRateLimit(senderId)) {
    return '⏳ استخدمت Gemini كتير دلوقتي 😅 جرّب تاني بعد كام دقيقة.';
  }

  try {
    return '🤖 ' + await askGemini(match[1].trim());
  } catch (error) {
    console.error('Gemini request failed:', error.message);

    if (error.message === 'GEMINI_API_KEY is not configured.') {
      return '⚠️ Gemini مش متفعل حاليًا. أضف GEMINI_API_KEY في إعدادات البوت.';
    }

    if (error.message.startsWith('QUESTION_TOO_LONG:')) {
      return '⚠️ السؤال طويل أوي 😅 خليه ' + config.geminiMaxQuestionChars + ' حرف أو أقل.';
    }

    return '⚠️ حصلت مشكلة وأنا بحاول أسأل Gemini. جرّب تاني بعد شوية.';
  }
}

function weatherDescription(code) {
  const descriptions = {
    0: '☀️ صافٍ',
    1: '🌤️ غالبًا صافٍ',
    2: '⛅ غائم جزئيًا',
    3: '☁️ غائم',
    45: '🌫️ ضباب',
    48: '🌫️ ضباب متجمد',
    51: '🌦️ رذاذ خفيف',
    53: '🌦️ رذاذ متوسط',
    55: '🌧️ رذاذ كثيف',
    56: '🌧️ رذاذ متجمد خفيف',
    57: '🌧️ رذاذ متجمد كثيف',
    61: '🌧️ أمطار خفيفة',
    63: '🌧️ أمطار متوسطة',
    65: '🌧️ أمطار غزيرة',
    66: '🌧️ أمطار متجمدة خفيفة',
    67: '🌧️ أمطار متجمدة غزيرة',
    71: '🌨️ ثلوج خفيفة',
    73: '🌨️ ثلوج متوسطة',
    75: '❄️ ثلوج غزيرة',
    77: '❄️ حبيبات ثلجية',
    80: '🌦️ زخات مطر خفيفة',
    81: '🌦️ زخات مطر متوسطة',
    82: '⛈️ زخات مطر غزيرة',
    85: '🌨️ زخات ثلج خفيفة',
    86: '❄️ زخات ثلج غزيرة',
    95: '⛈️ عواصف رعدية',
    96: '⛈️ عواصف رعدية مع برد',
    99: '⛈️ عواصف رعدية مع برد شديد'
  };

  return descriptions[code] || '🌤️ حالة جوية غير محددة';
}

async function fetchWeather(location, targetDate) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');

  url.searchParams.set('latitude', String(location.latitude));
  url.searchParams.set('longitude', String(location.longitude));
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,weather_code');
  url.searchParams.set('timezone', location.timezone);
  url.searchParams.set('forecast_days', '3');
  url.searchParams.set('temperature_unit', 'celsius');

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000)
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error('Open-Meteo returned ' + response.status + ': ' + responseText);
  }

  const data = JSON.parse(responseText);

  if (
    !data.daily ||
    !Array.isArray(data.daily.time) ||
    !Array.isArray(data.daily.temperature_2m_max) ||
    !Array.isArray(data.daily.temperature_2m_min) ||
    !Array.isArray(data.daily.weather_code)
  ) {
    throw new Error('Open-Meteo returned an incomplete forecast for ' + location.name + '.');
  }

  const index = data.daily.time.indexOf(targetDate);

  if (index === -1) {
    throw new Error('Forecast date ' + targetDate + ' was not returned for ' + location.name + '.');
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
  const quotes = loadJsonList(quotesPath, 'quote');
  const state = loadState(config.stateFile, quotes);
  const shanashaDate = toDateKey(getDateParts('Africa/Cairo'));
  const riyadhDate = toDateKey(getDateParts('Asia/Riyadh'));

  if (state.lastWeatherDate === shanashaDate) {
    console.log('Weather for ' + shanashaDate + ' already sent; skipping duplicate run.');
    return;
  }

  const [shanasha, riyadh] = await Promise.all([
    fetchWeatherWithRetry(
      {
        name: WEATHER_LOCATION,
        latitude: WEATHER_LATITUDE,
        longitude: WEATHER_LONGITUDE,
        timezone: 'Africa/Cairo'
      },
      shanashaDate
    ),
    fetchWeatherWithRetry(
      {
        name: RIYADH_LOCATION,
        latitude: RIYADH_LATITUDE,
        longitude: RIYADH_LONGITUDE,
        timezone: 'Asia/Riyadh'
      },
      riyadhDate
    )
  ]);

  const text = [
    '🌤️ طقس اليوم — ' + formatArabicDate(shanashaDate),
    '',
    '📍 ' + shanasha.name,
    '🌡️ الحرارة: ' + shanasha.min + '° - ' + shanasha.max + '°',
    weatherDescription(shanasha.code),
    '',
    '━━━━━━━━━━━━',
    '',
    '📍 ' + riyadh.name,
    '🌡️ الحرارة: ' + riyadh.min + '° - ' + riyadh.max + '°',
    weatherDescription(riyadh.code)
  ].join('\n');

  await sendText(text);

  await updateState(config.stateFile, quotes, (freshState) => {
    freshState.lastWeatherDate = shanashaDate;
    freshState.totalWeatherSent += 1;
    freshState.totalMessagesSent += 1;
  });

  console.log('[' + new Date().toISOString() + '] Weather sent for ' + shanashaDate + '.');
}

async function sendFact() {
  const facts = loadJsonList(factsPath, 'fact');
  const quotes = loadJsonList(quotesPath, 'quote');
  const state = loadState(config.stateFile, quotes);
  const today = toDateKey(getDateParts('Africa/Cairo'));

  if (state.lastFactDate === today) return;

  const selected = chooseRandomItem(facts, state, 'factSentHashes', 'factCycle');

  await sendText('🧠 معلومة اليوم\n\n' + selected.item);

  await updateState(config.stateFile, quotes, (freshState) => {
    if (selected.cycleStarted) {
      freshState.factSentHashes = [];
      freshState.factCycle = Math.max(freshState.factCycle, state.factCycle);
    }

    freshState.factSentHashes.push(selected.hash);
    freshState.factSentHashes = [...new Set(freshState.factSentHashes)];
    freshState.lastFactDate = today;
    freshState.totalFactsSent += 1;
    freshState.totalMessagesSent += 1;
  });
}

async function sendQuote() {
  const quotes = loadJsonList(quotesPath, 'quote');
  const state = loadState(config.stateFile, quotes);
  const today = toDateKey(getDateParts('Africa/Cairo'));

  if (state.lastQuoteDate === today) return;

  const selected = chooseRandomItem(quotes, state, 'sentHashes', 'cycle');

  await sendText('💡 حكمة اليوم\n\n' + selected.item);

  await updateState(config.stateFile, quotes, (freshState) => {
    if (selected.cycleStarted) {
      freshState.sentHashes = [];
      freshState.cycle = Math.max(freshState.cycle, state.cycle);
    }

    freshState.sentHashes.push(selected.hash);
    freshState.sentHashes = [...new Set(freshState.sentHashes)];
    freshState.lastQuoteDate = today;
    freshState.totalQuotesSent += 1;
    freshState.totalMessagesSent += 1;
  });
}

module.exports = {
  sendText,
  handleAskCommand,
  sendWeather,
  sendFact,
  sendQuote
};
