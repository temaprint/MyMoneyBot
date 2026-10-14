import 'dotenv/config';

export const COINS = [
  { id: 'tron', symbol: 'TRX' },
  { id: 'binancecoin', symbol: 'BNB' },
  { id: 'the-open-network', symbol: 'TON' },
  { id: 'bitcoin', symbol: 'BTC' },
  { id: 'ethereum', symbol: 'ETH' },
  { id: 'litecoin', symbol: 'LTC' },
];

// Корзина фиата для раздела FIAT (RUI валют). R_USD = 0 — доллар база.
export const FIAT = ['USD', 'RUB', 'THB', 'KRW'];

// Валюты личных финансов: фиат + крипта корзины (курсы — из таблицы Price)
export const CURRENCIES = ['USD', 'RUB', 'THB', ...COINS.map((c) => c.symbol)];

// Метка окна -> количество дней для CoinGecko market_chart
export const WINDOWS = { '24h': 1, '7d': 7, '30d': 30, '365d': 365 };
export const DEFAULT_WINDOW = '30d';

// Русские алиасы для аргумента команды /rui
export const WINDOW_ALIASES = { '24ч': '24h', '7д': '7d', '30д': '30d', '365д': '365d' };

// Русские подписи окон для отчёта
export const WINDOW_LABELS_RU = { '24h': '24ч', '7d': '7д', '30d': '30д', '365d': '365д' };

export const BOT_TOKEN = process.env.BOT_TOKEN || '';
export const DAILY_POST_TIME = process.env.DAILY_POST_TIME || '09:00';
export const TIMEZONE = process.env.TIMEZONE || 'Europe/Moscow';

export const DATABASE_URL = process.env.DATABASE_URL || '';
export const APP_URL = process.env.APP_URL || '';
export const APP_PORT = Number(process.env.APP_PORT) || 3005; // порт на хосте (compose)
export const LISTEN_PORT = Number(process.env.LISTEN_PORT) || 3000; // порт внутри процесса
export const SNAPSHOT_INTERVAL_MIN = Number(process.env.SNAPSHOT_INTERVAL_MIN) || 60;
export const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS) || 30;
export const LOGIN_TOKEN_TTL_MIN = 5;

// ИИ-аналитика (z.ai, Anthropic-совместимый Messages API). Без ключа блок ИИ отключён (503).
export const GLM_API_KEY = process.env.GLM_API_KEY || '';
export const GLM_MODEL = process.env.GLM_MODEL || 'glm-5.3';
export const GLM_BASE_URL = process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic';

export const CACHE_TTL_MS = 10 * 60 * 1000;

// Админы раздела «Администрирование» (username в Telegram, без @, через запятую).
// Права выдаются при входе и самовосстанавливаются на любом запросе с сессией.
export const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function validateConfig() {
  const errors = [];
  if (!BOT_TOKEN) errors.push('BOT_TOKEN не задан (см. .env.example)');
  if (!DATABASE_URL) errors.push('DATABASE_URL не задан (см. .env.example)');
  if (!APP_URL || !/^https?:\/\//.test(APP_URL)) {
    errors.push(`APP_URL имеет неверный формат "${APP_URL}", ожидается http(s)://...`);
  }
  if (!/^\d{1,2}:\d{2}$/.test(DAILY_POST_TIME)) {
    errors.push(`DAILY_POST_TIME имеет неверный формат "${DAILY_POST_TIME}", ожидается ЧЧ:ММ`);
  } else {
    const [h, m] = DAILY_POST_TIME.split(':').map(Number);
    if (h > 23 || m > 59) errors.push(`DAILY_POST_TIME вне диапазона: ${DAILY_POST_TIME}`);
  }
  return errors;
}
