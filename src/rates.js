// Курсы корзины и фиата — только keyless-источники (CoinGecko закрыл public API в 2026-09).
// Крипто: Binance /api/v3 (тикеры батчем + дневные klines) для TRX/BNB/BTC/ETH/LTC;
// TON — Kraken (Binance остановил торги TONUSDT 2026-06-30, тикер отдаёт застывший close).
// Фиат: open.er-api.com (RUB/THB/KRW за 1 USD напрямую, обновление раз в сутки).
// Экспорты совместимы с прежним coingecko.js: getBasketReturns / getBasketPrices / getFiatRates.
import { COINS, WINDOWS, CACHE_TTL_MS } from './config.js';
import { computeRui } from './rui.js';

const BINANCE = 'https://api.binance.com/api/v3';
const KRAKEN = 'https://api.kraken.com/0/public';
const FIAT_API = 'https://open.er-api.com/v6/latest/USD';

// Монеты, которые берём с Kraken (на Binance торговля остановлена)
const KRAKEN_SYMBOLS = new Set(['TON']);

const MS_PER_DAY = 86_400_000;
const RETRY_DELAYS_MS = [2000, 5000, 10000];
const FIAT_TTL_MS = 60 * 60 * 1000; // er-api обновляет данные раз в сутки

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Сетевые ошибки и 429/5xx — ретраим с backoff; остальные 4xx — сразу throw.
async function fetchJson(url, label) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`${label}: HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.message?.startsWith(`${label}: HTTP`)) throw err;
      lastError = err; // сетевые ошибки — ретраим
    }
  }
  throw lastError;
}

// 'YYYY-MM-DD' из ms (дневные свечи Binance/Kraken начинаются в 00:00 UTC)
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

async function binanceDailyCloses(symbol) {
  // limit=400: хватает на базу окна 365д + сегодня
  const data = await fetchJson(
    `${BINANCE}/klines?symbol=${symbol}USDT&interval=1d&limit=400`,
    'Binance'
  );
  const closes = new Map();
  for (const k of data) closes.set(dayKey(k[0]), Number(k[4])); // k[4] = close
  return closes;
}

async function krakenDailyCloses(symbol) {
  const data = await fetchJson(`${KRAKEN}/OHLC?pair=${symbol}USD&interval=1440`, 'Kraken');
  if (data.error?.length) throw new Error(`Kraken: ${data.error[0]}`);
  const key = Object.keys(data.result ?? {}).find((k) => k !== 'last');
  const closes = new Map();
  for (const c of data.result?.[key] ?? []) closes.set(dayKey(c[0] * 1000), Number(c[4]));
  return closes;
}

// Общий кэш корзины: один набор запросов (~7) кормит все окна и getBasketPrices.
const basketCache = { at: 0, data: null };

async function fetchBasket() {
  if (basketCache.data && Date.now() - basketCache.at < CACHE_TTL_MS) return basketCache.data;

  // Текущие цены: Binance одним батч-запросом
  const binanceCoins = COINS.filter((c) => !KRAKEN_SYMBOLS.has(c.symbol));
  const prices = new Map();
  const pairs = binanceCoins.map((c) => `${c.symbol}USDT`);
  const tickers = await fetchJson(
    `${BINANCE}/ticker/price?symbols=${encodeURIComponent(JSON.stringify(pairs))}`,
    'Binance'
  );
  const byPair = new Map(tickers.map((t) => [t.symbol, Number(t.price)]));
  for (const c of binanceCoins) {
    const p = byPair.get(`${c.symbol}USDT`);
    if (Number.isFinite(p)) prices.set(c.symbol, p);
  }

  // Kraken-монеты: тикер (цена) — сбой не валит корзину, монета просто исключится
  for (const c of COINS.filter((x) => KRAKEN_SYMBOLS.has(x.symbol))) {
    try {
      const data = await fetchJson(`${KRAKEN}/Ticker?pair=${c.symbol}USD`, 'Kraken');
      const entry = Object.values(data.result ?? {})[0];
      const p = Number(entry?.c?.[0]);
      if (Number.isFinite(p)) prices.set(c.symbol, p);
    } catch {
      // без цены — монета попадёт в failures
    }
  }

  // Дневные закрытия по монетам; сбой одной монеты не валит остальные
  const closes = new Map();
  await Promise.allSettled(
    COINS.map(async (c) => {
      const series = KRAKEN_SYMBOLS.has(c.symbol)
        ? await krakenDailyCloses(c.symbol)
        : await binanceDailyCloses(c.symbol);
      closes.set(c.symbol, series);
    })
  );

  basketCache.at = Date.now();
  basketCache.data = { prices, closes };
  return basketCache.data;
}

// Расчёт по всей корзине для окна ('24h' | '7d' | '30d' | '365d').
// R = живая цена / close N дней назад - 1 (та же база, что у ретроспективы из Price).
// Монета без данных попадает в failures и исключается; если осталось < 2 — throw.
export async function getBasketReturns(windowLabel) {
  const nDays = WINDOWS[windowLabel];
  if (!nDays) throw new Error(`Неизвестное окно: ${windowLabel}`);

  const { prices, closes } = await fetchBasket();
  const baseKey = dayKey(Date.now() - nDays * MS_PER_DAY);

  const returns = [];
  const failures = [];
  for (const coin of COINS) {
    const price = prices.get(coin.symbol);
    const base = closes.get(coin.symbol)?.get(baseKey);
    if (Number.isFinite(price) && Number.isFinite(base) && base > 0) {
      returns.push({ symbol: coin.symbol, r: (price / base - 1) * 100 });
    } else {
      failures.push(coin.symbol);
    }
  }

  if (returns.length < 2) {
    throw new Error(
      `Нет данных по окну для ${failures.join(', ')} — для расчёта нужно минимум 2 монеты`
    );
  }
  return { ...computeRui(returns), failures };
}

// Текущие цены корзины из того же кэша
export async function getBasketPrices() {
  const { prices } = await fetchBasket();
  return [...prices].map(([symbol, price]) => ({ symbol, price }));
}

// --- Фиатные курсы (RUB, THB, KRW к USD) для раздела FIAT и личных финансов ---
// er-api отдаёт единиц фиата за 1 USD напрямую (без BTC-кросса).

const fiatCache = { at: 0, data: null };

// -> { RUB: 82.5, THB: 32.1, KRW: 1340 } — единиц фиата за 1 USD (null = нет данных)
export async function getFiatRates() {
  if (fiatCache.data && Date.now() - fiatCache.at < FIAT_TTL_MS) return fiatCache.data;
  const data = await fetchJson(FIAT_API, 'Курсы фиата');
  const r = data.rates ?? {};
  const rates = {
    RUB: typeof r.RUB === 'number' ? r.RUB : null,
    THB: typeof r.THB === 'number' ? r.THB : null,
    KRW: typeof r.KRW === 'number' ? r.KRW : null,
  };
  fiatCache.at = Date.now();
  fiatCache.data = rates;
  return rates;
}
