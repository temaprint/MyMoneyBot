// Ретроспективные ряды из дневных цен (таблица Price).
// RUI/R пересчитываются на лету за любой период: не нужны исторические
// снапшоты — достаточно двух точек цены (сейчас и N дней назад).
import { prisma } from './db.js';
import { WINDOWS, COINS } from './config.js';
import { computeRui } from './rui.js';

const MS_PER_DAY = 86_400_000;
const round2 = (x) => Math.round(x * 100) / 100;
// 6 значащих цифр: хватает для графика, короче full-precision float
const roundPrice = (x) => Number(x.toPrecision(6));

// Map<symbol, Map<dateMs, price>> начиная с fromDate
async function loadDailyPrices(fromDate, symbols = COINS.map((c) => c.symbol)) {
  const rows = await prisma.price.findMany({
    where: { date: { gte: fromDate }, symbol: { in: symbols } },
    orderBy: { date: 'asc' },
  });
  const bySymbol = new Map(symbols.map((s) => [s, new Map()]));
  for (const { symbol, date, price } of rows) {
    bySymbol.get(symbol)?.set(date.getTime(), price);
  }
  return bySymbol;
}

// Общие для всей корзины границы дат (все монеты имеют цену)
function commonBounds(bySymbol) {
  let start = -Infinity;
  let end = Infinity;
  for (const m of bySymbol.values()) {
    if (m.size === 0) return null;
    start = Math.max(start, Math.min(...m.keys()));
    end = Math.min(end, Math.max(...m.keys()));
  }
  return { start, end };
}

// Ряд RUI/R за окно windowLabel, посчитанный из дневных цен.
// Формат как у /api/snapshots: { ts, mean, series: [{symbol, rui[], r[]}] };
// metric 'rui'|'r' оставляет только нужное поле (график показывает одно).
// Начало ряда = общий старт корзины + окно (нужна базовая точка),
// т.е. для полного состава данные с 2024-08 (листинг TON) + N дней.
export async function getHistorySeries(windowLabel, rangeDays, metric, symbols = COINS.map((c) => c.symbol)) {
  const days = WINDOWS[windowLabel];
  if (!days) throw new Error(`Неизвестное окно: ${windowLabel}`);

  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  // базовые точки нужны за `days` до начала видимого диапазона (и день запаса)
  const lookback = (rangeDays ?? 3650) + days + 2;
  const bySymbol = await loadDailyPrices(new Date(now.getTime() - lookback * MS_PER_DAY), symbols);
  const bounds = commonBounds(bySymbol);
  if (!bounds) return { window: windowLabel, ts: [], mean: [], series: [] };

  const visibleFrom = rangeDays ? now.getTime() - rangeDays * MS_PER_DAY : -Infinity;
  const offset = days * MS_PER_DAY;

  const ts = [];
  const mean = [];
  const series = new Map(
    symbols.map((s) => [
      s,
      { symbol: s, ...(metric !== 'r' && { rui: [] }), ...(metric !== 'rui' && { r: [] }) },
    ])
  );

  for (let d = bounds.start + offset; d <= bounds.end; d += MS_PER_DAY) {
    if (d < visibleFrom) continue;
    const items = [];
    let complete = true;
    for (const [symbol, m] of bySymbol) {
      const cur = m.get(d);
      const base = m.get(d - offset);
      if (cur === undefined || base === undefined) {
        complete = false;
        break;
      }
      items.push({ symbol, r: (cur / base - 1) * 100 });
    }
    if (!complete) continue; // дыра в истории — пропускаем день

    const { mean: m, items: withRui } = computeRui(items);
    ts.push(d);
    mean.push(round2(m));
    for (const item of withRui) {
      const s = series.get(item.symbol);
      if (metric !== 'r') s.rui.push(round2(item.rui));
      if (metric !== 'rui') s.r.push(round2(item.r));
    }
  }
  return { window: windowLabel, ts, mean, series: [...series.values()] };
}

// Ряды цен: у каждой монеты своё покрытие (TON с 2024-08, остальные ~5 лет).
// Общая ось дат = объединение; пропуски -> null (график сам разорвёт линию).
// Формат: { ts, series: [{symbol, price[]}] }
export async function getPriceSeries(rangeDays, symbols = COINS.map((c) => c.symbol)) {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  const fromDate = rangeDays ? new Date(now.getTime() - rangeDays * MS_PER_DAY) : new Date(0);
  const bySymbol = await loadDailyPrices(fromDate, symbols);

  const union = new Set();
  for (const m of bySymbol.values()) for (const key of m.keys()) union.add(key);
  const ts = [...union].sort((a, b) => a - b);

  const series = [...bySymbol.entries()].map(([symbol, m]) => ({
    symbol,
    price: ts.map((t) => {
      const p = m.get(t);
      return p === undefined ? null : roundPrice(p);
    }),
  }));
  return { ts, series };
}

// Сводка за период (для таблицы и ИИ-контекста): по каждой монете
// цена на начало/конец, min/max, R и RUI; средняя корзины M.
// rangeDays=null -> от общего старта полной корзины.
// Старт периода выравнивается так, чтобы в него попали все монеты корзины.
export async function getPeriodStats(rangeDays, symbols = COINS.map((c) => c.symbol)) {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  const wanted = rangeDays ? now.getTime() - rangeDays * MS_PER_DAY : null;

  const fromDate = rangeDays ? new Date(wanted - 2 * MS_PER_DAY) : new Date(0);
  const bySymbol = await loadDailyPrices(fromDate, symbols);
  const bounds = commonBounds(bySymbol);
  if (!bounds) return null;

  // общий старт: первая дата >= wanted (или общий старт корзины)
  let from;
  if (wanted === null) {
    from = bounds.start;
  } else {
    from = -Infinity;
    for (const m of bySymbol.values()) {
      let first = null;
      for (const key of m.keys()) {
        if (key >= wanted) {
          first = key;
          break;
        }
      }
      if (first === null) return null; // период вне данных монеты
      from = Math.max(from, first);
    }
  }

  const items = [];
  for (const [symbol, m] of bySymbol) {
    const prices = [...m.entries()].filter(([t]) => t >= from).map(([, p]) => p);
    if (prices.length < 2) return null;
    const startPrice = prices[0];
    const endPrice = prices[prices.length - 1];
    items.push({
      symbol,
      startPrice: roundPrice(startPrice),
      endPrice: roundPrice(endPrice),
      minPrice: roundPrice(Math.min(...prices)),
      maxPrice: roundPrice(Math.max(...prices)),
      r: (endPrice / startPrice - 1) * 100,
    });
  }
  const { mean, items: withRui } = computeRui(items.map(({ symbol, r }) => ({ symbol, r })));
  const bySymbolRui = new Map(withRui.map((it) => [it.symbol, it.rui]));
  return {
    from: new Date(from).toISOString().slice(0, 10),
    to: new Date(bounds.end).toISOString().slice(0, 10),
    mean,
    items: items.map((it) => ({ ...it, r: round2(it.r), rui: round2(bySymbolRui.get(it.symbol)) })),
  };
}
