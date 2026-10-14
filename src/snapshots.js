// Периодическое сохранение истории RUI в БД (по всем окнам)
// + актуализация сегодняшней дневной цены + снимки личного богатства.
// Источники keyless (Binance + Kraken + er-api), кэш внутри rates.js.
import { prisma } from './db.js';
import { getBasketReturns, getBasketPrices, getFiatRates } from './rates.js';
import { collectWealthSnapshots } from './finance.js';
import { WINDOWS, FIAT } from './config.js';

export async function collectSnapshots() {
  const ts = new Date();
  let saved = 0;
  for (const window of Object.keys(WINDOWS)) {
    try {
      const { mean, items } = await getBasketReturns(window);
      await prisma.snapshot.createMany({
        data: items.map((item) => ({
          ts,
          symbol: item.symbol,
          window,
          r: item.r,
          rui: item.rui,
          mean,
        })),
      });
      saved += items.length;
    } catch (err) {
      console.error(`[snapshots] окно ${window}:`, err.message ?? err);
    }
  }
  // «Закрытие» текущего дня — питает историю и режим цен между бэкфиллами
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (const { symbol, price } of await getBasketPrices()) {
      await prisma.price.upsert({
        where: { symbol_date: { symbol, date: today } },
        update: { price },
        create: { symbol, date: today, price },
      });
    }
    // фиат для раздела FIAT: USD за единицу (USD=1, остальные — инверсия курса er-api)
    const fiat = await getFiatRates();
    const fiatRows = [{ symbol: 'USD', price: 1 }];
    for (const symbol of FIAT) {
      if (symbol !== 'USD' && fiat[symbol]) fiatRows.push({ symbol, price: 1 / fiat[symbol] });
    }
    for (const { symbol, price } of fiatRows) {
      await prisma.price.upsert({
        where: { symbol_date: { symbol, date: today } },
        update: { price },
        create: { symbol, date: today, price },
      });
    }
  } catch (err) {
    console.error('[snapshots] цены:', err.message ?? err);
  }

  // богатство пользователей (личные финансы): одна точка на день, upsert
  try {
    const users = await collectWealthSnapshots();
    if (users) console.log(`[snapshots] богатство: обновлено точек — ${users}`);
  } catch (err) {
    console.error('[snapshots] богатство:', err.message ?? err);
  }

  // ленивая чистка истёкших сессий
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
  if (saved) console.log(`[snapshots] ${ts.toISOString()}: сохранено ${saved} строк`);
}
