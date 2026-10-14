// Курсы к USD для личных финансов (кэш 10 мин): 1 единица валюты = rate долларов.
// Вынесено из finance.js, чтобы модули финансов и сделок делили один кэш без циклов импорта.
import { prisma } from './db.js';
import { CURRENCIES, CACHE_TTL_MS } from './config.js';

const ratesCache = { at: 0, data: null };

// Читаем из таблицы Price (последняя строка на валюту): её ежечасно пишет
// collectSnapshots. Финансы не ходят во внешние API — траты работают,
// даже когда биржи/курсовые API лежат (курс максимум на час устаревает,
// при долгом отказе — последний дневной close).
export async function getUsdRates() {
  if (ratesCache.data && Date.now() - ratesCache.at < CACHE_TTL_MS) return ratesCache.data;
  const rows = await prisma.price.findMany({
    where: { symbol: { in: CURRENCIES } },
    distinct: ['symbol'],
    orderBy: [{ date: 'desc' }, { symbol: 'asc' }], // последняя строка каждой валюты
    select: { symbol: true, price: true },
  });
  const rates = new Map([['USD', 1]]);
  for (const { symbol, price } of rows) {
    if (Number.isFinite(price) && price > 0) rates.set(symbol, price);
  }
  ratesCache.at = Date.now();
  ratesCache.data = rates;
  return rates;
}

export async function toUsd(amount, currency) {
  const rates = await getUsdRates();
  const rate = rates.get(currency);
  if (typeof rate !== 'number') throw new Error(`Нет курса для ${currency}`);
  return amount * rate;
}
