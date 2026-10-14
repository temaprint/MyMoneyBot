// Проверка качества данных в таблице Price.
// Запуск: node src/check-prices.js  (локально или docker compose exec app ...)
// Проверяет: покрытие и непрерывность по дням, аномальные значения,
// min/max цен, точечную сверку истории с Binance, актуальность против
// живых бирж (Binance + Kraken для TON), шов TON (Binance -> Kraken)
// и R(30d) из дневных цен против живого расчёта с бирж.
import 'dotenv/config';
import { prisma } from './db.js';
import { COINS } from './config.js';

const MS = 86400000;
let problems = 0;
const ok = (msg) => console.log(`  [ok] ${msg}`);
const warn = (msg) => console.log(`  [!] ${msg}`);
const fail = (msg) => { problems++; console.log(`  [FAIL] ${msg}`); };

const dayStr = (d) => new Date(d).toISOString().slice(0, 10);

async function coverageAndAnomalies() {
  console.log('\n== 1. Покрытие, непрерывность, аномалии ==');
  for (const coin of COINS) {
    const rows = await prisma.price.findMany({
      where: { symbol: coin.symbol },
      orderBy: { date: 'asc' },
      select: { date: true, price: true },
    });
    if (rows.length === 0) { fail(`${coin.symbol}: данных нет`); continue; }

    const dates = rows.map((r) => r.date.getTime());
    const first = dates[0];
    const last = dates.at(-1);
    const expected = Math.round((last - first) / MS) + 1;
    const missing = expected - rows.length;
    const bad = rows.filter((r) => !Number.isFinite(r.price) || r.price <= 0);

    // дырки внутри диапазона (не только количество)
    const dateSet = new Set(dates);
    const holes = [];
    for (let d = first; d <= last && holes.length < 5; d += MS) {
      if (!dateSet.has(d)) holes.push(dayStr(d));
    }

    const minP = Math.min(...rows.map((r) => r.price));
    const maxP = Math.max(...rows.map((r) => r.price));
    const line = `${coin.symbol}: ${rows.length} дней (${dayStr(first)} .. ${dayStr(last)}), цена ${minP.toFixed(4)}..${maxP.toFixed(4)}`;
    if (missing === 0 && bad.length === 0) ok(line);
    else {
      warn(line);
      if (missing > 0) fail(`${coin.symbol}: ${missing} пропущенных дней, напр. ${holes.join(', ')}`);
      if (bad.length > 0) fail(`${coin.symbol}: ${bad.length} аномальных значений (<=0 или NaN)`);
    }
  }
}

async function binanceSpotCheck() {
  console.log('\n== 2. Точечная сверка истории с Binance (3 случайных дня на монету) ==');
  for (const coin of COINS) {
    const rows = await prisma.price.findMany({
      where: { symbol: coin.symbol, date: { lte: new Date('2026-06-01') } }, // эпоха Binance для всех
      orderBy: { date: 'asc' },
      select: { date: true, price: true },
    });
    const picks = [0, 0, 0].map(() => rows[Math.floor(Math.random() * rows.length)]).filter(Boolean);
    for (const row of picks) {
      const url = `https://api.binance.com/api/v3/klines?symbol=${coin.symbol}USDT&interval=1d&limit=1&startTime=${row.date.getTime()}`;
      const res = await fetch(url);
      if (!res.ok) { warn(`${coin.symbol} ${dayStr(row.date)}: Binance HTTP ${res.status}`); continue; }
      const candles = await res.json();
      const close = Number(candles[0]?.[4]);
      if (close === undefined) { warn(`${coin.symbol} ${dayStr(row.date)}: свечи нет`); continue; }
      const diff = Math.abs(close - row.price) / close * 100;
      if (diff < 0.01) ok(`${coin.symbol} ${dayStr(row.date)}: ${row.price} == ${close}`);
      else fail(`${coin.symbol} ${dayStr(row.date)}: в БД ${row.price}, у Binance ${close} (расхождение ${diff.toFixed(2)}%)`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Живые цены: Binance батчем для всех, кроме TON (торги там остановлены) — Kraken
async function fetchLivePrices() {
  const live = new Map();
  const pairs = COINS.filter((c) => c.symbol !== 'TON').map((c) => `${c.symbol}USDT`);
  const res = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(pairs))}`
  );
  if (res.ok) {
    for (const t of await res.json()) live.set(t.symbol.replace('USDT', ''), Number(t.price));
  } else {
    warn(`Binance HTTP ${res.status} — сверка актуальности недоступна`);
  }
  const kr = await fetch('https://api.kraken.com/0/public/Ticker?pair=TONUSD');
  if (kr.ok) {
    const entry = Object.values((await kr.json()).result ?? {})[0];
    if (entry?.c?.[0]) live.set('TON', Number(entry.c[0]));
  } else {
    warn(`Kraken HTTP ${kr.status} — TON без сверки`);
  }
  return live;
}

// Дневные закрытия с биржи (Map 'YYYY-MM-DD' -> close), как в rates.js
async function fetchDailyCloses(symbol) {
  const url =
    symbol === 'TON'
      ? 'https://api.kraken.com/0/public/OHLC?pair=TONUSD&interval=1440'
      : `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1d&limit=60`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (symbol === 'TON') {
    if (data.error?.length) return null;
    const key = Object.keys(data.result ?? {}).find((k) => k !== 'last');
    return new Map((data.result?.[key] ?? []).map((c) => [dayStr(c[0] * 1000), Number(c[4])]));
  }
  return new Map(data.map((k) => [dayStr(k[0]), Number(k[4])]));
}

async function liveCrossCheck() {
  console.log('\n== 3. Актуальность: последняя цена в БД vs живые биржи ==');
  const live = await fetchLivePrices();

  console.log('\n== 4. R(30d) из дневных цен vs живой расчёт с бирж ==');
  for (const coin of COINS) {
    const last = await prisma.price.findFirst({
      where: { symbol: coin.symbol },
      orderBy: { date: 'desc' },
    });
    const price = live.get(coin.symbol);
    if (!last || price === undefined) { fail(`${coin.symbol}: нет данных для сверки`); continue; }
    const diff = Math.abs(last.price - price) / price * 100;
    if (diff < 5) ok(`${coin.symbol}: БД ${last.price.toFixed(4)} (${dayStr(last.date)}) vs биржа ${price} — ${diff.toFixed(2)}%`);
    else fail(`${coin.symbol}: БД ${last.price} (${dayStr(last.date)}) vs биржа ${price} — ${diff.toFixed(2)}%`);

    // R(30d): база = ровно на 30 дней раньше последней даты; сравниваем
    // ретро-расчёт из Price с живым расчётом по закрытиям биржи (как rates.js)
    const baseKey = dayStr(last.date.getTime() - 30 * MS);
    const base = await prisma.price.findFirst({
      where: { symbol: coin.symbol, date: { lte: new Date(`${baseKey}T00:00:00Z`) } },
      orderBy: { date: 'desc' },
    });
    const closes = await fetchDailyCloses(coin.symbol);
    const exBase = closes ? [...closes].filter(([d, c]) => d <= baseKey && c > 0).at(-1) : null;
    if (base && exBase) {
      const dbR = (last.price / base.price - 1) * 100;
      const liveR = (price / exBase[1] - 1) * 100;
      const d = Math.abs(liveR - dbR);
      if (d < 3) ok(`${coin.symbol}: R30d БД ${dbR.toFixed(2)}% vs биржа ${liveR.toFixed(2)}% (Δ${d.toFixed(2)}п.п.)`);
      else warn(`${coin.symbol}: R30d БД ${dbR.toFixed(2)}% vs биржа ${liveR.toFixed(2)}% (Δ${d.toFixed(2)}п.п.) — рынок мог уйти`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function tonSeam() {
  console.log('\n== 5. Шов TON: Binance (до 2026-06-30) -> Kraken (с 2026-07-01) ==');
  const rows = await prisma.price.findMany({
    where: { symbol: 'TON', date: { gte: new Date('2026-06-27'), lte: new Date('2026-07-04') } },
    orderBy: { date: 'asc' },
  });
  let prev = null;
  for (const r of rows) {
    const jump = prev ? Math.abs(r.price / prev - 1) * 100 : 0;
    console.log(`  ${dayStr(r.date)}: ${r.price.toFixed(4)}${prev ? `  (${jump.toFixed(1)}% к пред. дню)` : ''}`);
    prev = r.price;
  }
  const seam = rows.filter((r) => r.date.getTime() >= new Date('2026-07-01').getTime());
  if (seam.length === 0) fail('нет строк TON после 2026-06-30 — хвост не добран');
  else ok(`хвост после Binance есть (${seam.length} строк начиная с ${dayStr(seam[0].date)})`);
}

async function main() {
  console.log(`Проверка Price: ${await prisma.price.count()} строк всего`);
  await coverageAndAnomalies();
  await binanceSpotCheck();
  await liveCrossCheck();
  await tonSeam();
  console.log(`\n${problems ? `НАЙДЕНО ПРОБЛЕМ: ${problems}` : 'ПРОБЛЕМ НЕ НАЙДЕНО'}`);
  await prisma.$disconnect();
  process.exit(problems ? 1 : 0);
}

main().catch((err) => {
  console.error('Проверка не удалась:', err.message ?? err);
  process.exit(1);
});
