// Бэкфилл дневных цен за ~5 лет с публичного API Binance (без ключа).
// Запуск: node src/backfill-prices.js [годы]
//   docker compose exec app node src/backfill-prices.js        (по умолчанию 5 лет)
// Свеча 1d: openTime -> дата (00:00 UTC), close -> цена.
// За запрос до 1000 свечей, пагинация по startTime.
// Если данные с Binance устарели (>3 дней — например, TONUSDT: торги
// остановлены в 2026-06), хвост добирается с Kraken OHLC (до 719 дневок).
import 'dotenv/config';
import { prisma } from './db.js';
import { COINS } from './config.js';

const YEARS = Number(process.argv[2]) || 5;
const BASE = 'https://api.binance.com/api/v3/klines';
const KRAKEN_OHLC = 'https://api.kraken.com/0/public/OHLC';
const PAGE_LIMIT = 1000;
const MS_PER_DAY = 86_400_000;

async function fetchPage(symbol, startTime) {
  const url = `${BASE}?symbol=${symbol}USDT&interval=1d&limit=${PAGE_LIMIT}&startTime=${startTime}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
}

async function backfillCoin(coin, fromMs) {
  const rows = [];
  let startTime = fromMs;
  while (true) {
    const candles = await fetchPage(coin.symbol, startTime);
    for (const c of candles) {
      const date = new Date(c[0]); // openTime свечи = 00:00 UTC дня
      date.setUTCHours(0, 0, 0, 0);
      rows.push({ symbol: coin.symbol, date, price: Number(c[4]) }); // c[4] = close
    }
    if (candles.length < PAGE_LIMIT) break;
    startTime = candles[candles.length - 1][0] + MS_PER_DAY;
    await new Promise((r) => setTimeout(r, 500)); // бережём лимиты
  }
  return rows;
}

// Хвост с Kraken (дневные OHLC, до 719 свечей), если Binance устарел.
// Кейс TON: торги TONUSDT остановлены 2026-06-30, тикер Binance застыл.
async function topUpFromKraken(coin, lastDate) {
  const url = `${KRAKEN_OHLC}?pair=${coin.symbol}USD&interval=1440`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.error?.length) throw new Error(`Kraken: ${data.error[0]}`);
      const key = Object.keys(data.result ?? {}).find((k) => k !== 'last');
      const fresh = (data.result?.[key] ?? [])
        // [ts-сек, open, high, low, close, ...]; только даты после lastDate
        .filter(([ts]) => ts * 1000 >= lastDate.getTime() + MS_PER_DAY)
        .map(([ts, , , , close]) => {
          const date = new Date(ts * 1000);
          date.setUTCHours(0, 0, 0, 0);
          return { symbol: coin.symbol, date, price: Number(close) };
        });
      if (fresh.length) {
        await prisma.price.createMany({ data: fresh, skipDuplicates: true });
      }
      return fresh.length;
    }
    if (res.status !== 429 && res.status < 500) throw new Error(`Kraken HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 5000));
  }
  throw new Error('Kraken: превышены попытки после 429');
}

async function main() {
  const fromMs = Date.now() - YEARS * 365 * MS_PER_DAY;
  console.log(`Бэкфилл цен за ~${YEARS} лет (с ${new Date(fromMs).toISOString().slice(0, 10)})`);
  let failed = 0;
  const staleAfter = Date.now() - 3 * MS_PER_DAY;
  for (const coin of COINS) {
    try {
      const rows = await backfillCoin(coin, fromMs);
      if (rows.length) {
        await prisma.price.createMany({ data: rows, skipDuplicates: true });
      }
      const first = rows.length ? rows[0].date.toISOString().slice(0, 10) : '-';
      const last = rows.length ? rows.at(-1).date.toISOString().slice(0, 10) : '-';
      console.log(`[ok] ${coin.symbol}: ${rows.length} дней Binance (${first} .. ${last})`);

      if (!rows.length || rows.at(-1).date.getTime() < staleAfter) {
        const lastDate = rows.length ? rows.at(-1).date : new Date(0);
        const added = await topUpFromKraken(coin, lastDate);
        console.log(`[ok] ${coin.symbol}: +${added} дней с Kraken (хвост после ${lastDate.toISOString().slice(0, 10)})`);
      }
    } catch (err) {
      failed++;
      console.error(`[fail] ${coin.symbol}:`, err.message ?? err);
    }
  }
  for (const coin of COINS) {
    const [min, max, cnt] = await Promise.all([
      prisma.price.findFirst({ where: { symbol: coin.symbol }, orderBy: { date: 'asc' } }),
      prisma.price.findFirst({ where: { symbol: coin.symbol }, orderBy: { date: 'desc' } }),
      prisma.price.count({ where: { symbol: coin.symbol } }),
    ]);
    console.log(
      `[итог] ${coin.symbol}: ${cnt} дней (${min?.date.toISOString().slice(0, 10) ?? '-'} .. ${max?.date.toISOString().slice(0, 10) ?? '-'})`
    );
  }
  const total = await prisma.price.count();
  console.log(`Всего строк в Price: ${total}`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('Бэкфилл не удался:', err.message ?? err);
  process.exit(1);
});
