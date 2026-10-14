// Сделки-позиции: купил крипту со счёта (списание в её валюте), монеты живут
// внутри сделки. Открытые сделки входят в богатство (счета + сделки),
// пороги alertUp/alertDown шлют уведомление в Telegram при движении цены от входа.
import { prisma } from './db.js';
import { getUsdRates, toUsd } from './usrates.js';
import { COINS } from './config.js';

// Крипта, доступная для сделок (фиатные счёта финансируют, крипта — позиция)
export const DEAL_SYMBOLS = COINS.map((c) => c.symbol);

const asIds = (x) => (Array.isArray(x) ? x : [x]);

const fmtQty = (v) => String(Number(v.toPrecision(8)));
const fmtUsd = (v) => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtPriceUsd = (v) => '$' + Number(v.toPrecision(4));

// Покупка: списание со счёта (amount в его валюте) + позиция qty монет.
// Строка операции — expense с excluded (вне графика трат, богатство не «тратится»).
export async function applyDealBuy({ userId, ids, fromAccountId, symbol, amount, qty, alertUp, alertDown, note }) {
  const account = await prisma.account.findUnique({ where: { id: fromAccountId } });
  if (!account || !asIds(ids ?? [userId]).includes(account.userId)) throw new Error('Счёт не найден');
  if (!DEAL_SYMBOLS.includes(symbol)) throw new Error(`Сделки доступны только с криптой: ${DEAL_SYMBOLS.join(', ')}`);
  if (!(amount > 0)) throw new Error('Сумма должна быть > 0');
  if (!(qty > 0)) throw new Error('Количество монет должно быть > 0');
  if (amount > account.balance) {
    throw new Error(`Недостаточно средств: на счёте «${account.name}» ${account.balance} ${account.currency}`);
  }
  const usd = await toUsd(amount, account.currency);
  if (!(usd > 0)) throw new Error(`Нет курса для ${account.currency}`);

  const deal = await prisma.$transaction(async (tx) => {
    const created = await tx.deal.create({
      data: {
        userId,
        symbol,
        qty,
        spentAmount: amount,
        spentCurrency: account.currency,
        spentUsd: usd,
        buyPriceUsd: usd / qty,
        alertUp: alertUp ?? null,
        alertDown: alertDown ?? null,
        note: note || null,
      },
    });
    await tx.transaction.create({
      data: {
        userId,
        accountId: account.id,
        kind: 'expense',
        amount,
        currency: account.currency,
        usd,
        accountAmount: amount,
        excluded: true, // это не трата: деньги перешли в позицию
        description: `Покупка ${fmtQty(qty)} ${symbol}`,
        dealId: created.id,
      },
    });
    await tx.account.update({ where: { id: account.id }, data: { balance: { decrement: amount } } });
    return created;
  });
  return { deal, account: await prisma.account.findUnique({ where: { id: account.id } }) };
}

// Закрытие (продажа): зачисление на счёт amount единиц в его валюте
// (не задан — по рыночному кроссу через USD). Реализованный P&L = proceedsUsd − spentUsd.
export async function closeDeal({ userId, ids, dealId, toAccountId, amount }) {
  const famIds = asIds(ids ?? [userId]);
  const [deal, account] = await Promise.all([
    prisma.deal.findUnique({ where: { id: dealId } }),
    prisma.account.findUnique({ where: { id: toAccountId } }),
  ]);
  if (!deal || !famIds.includes(deal.userId)) throw new Error('Сделка не найдена');
  if (deal.status !== 'open') throw new Error('Сделка уже закрыта');
  if (!account || !famIds.includes(account.userId)) throw new Error('Счёт не найден');
  if (amount != null && !(amount > 0)) throw new Error('Сумма зачисления должна быть числом > 0');

  const rates = await getUsdRates();
  const symbolRate = rates.get(deal.symbol);
  const accountRate = rates.get(account.currency);
  if (typeof symbolRate !== 'number') throw new Error(`Нет курса для ${deal.symbol}`);
  if (typeof accountRate !== 'number') throw new Error(`Нет курса для ${account.currency}`);
  const inAmount = amount != null ? amount : (deal.qty * symbolRate) / accountRate;
  const proceedsUsd = inAmount * accountRate;

  const [updated] = await prisma.$transaction([
    prisma.deal.update({
      where: { id: deal.id },
      data: {
        status: 'closed',
        proceedsAmount: inAmount,
        proceedsCurrency: account.currency,
        proceedsUsd,
        closedAt: new Date(),
      },
    }),
    prisma.transaction.create({
      data: {
        userId,
        accountId: account.id,
        kind: 'income',
        amount: inAmount,
        currency: account.currency,
        usd: proceedsUsd,
        accountAmount: inAmount,
        excluded: true, // не доход: позиция вернулась в деньги
        description: `Продажа ${fmtQty(deal.qty)} ${deal.symbol}`,
        dealId: deal.id,
      },
    }),
    prisma.account.update({ where: { id: account.id }, data: { balance: { increment: inAmount } } }),
  ]);
  return { deal: updated, account: await prisma.account.findUnique({ where: { id: account.id } }) };
}

// Правка порогов уведомлений и заметки. Смена порога сбрасывает его notified-флаг —
// новый порог сможет прислать свежий сигнал.
export async function updateDealById(userIds, dealId, { alertUp, alertDown, note }) {
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal || !asIds(userIds).includes(deal.userId)) throw new Error('Сделка не найдена');
  const parse = (v) => {
    if (v === null || v === '' || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new Error('Порог должен быть числом от 0 до 1000 (%)');
    return n;
  };
  const data = {};
  if (alertUp !== undefined) {
    data.alertUp = parse(alertUp);
    if (data.alertUp !== deal.alertUp) data.notifiedUpAt = null;
  }
  if (alertDown !== undefined) {
    data.alertDown = parse(alertDown);
    if (data.alertDown !== deal.alertDown) data.notifiedDownAt = null;
  }
  if (note !== undefined) data.note = String(note ?? '').trim().slice(0, 200) || null;
  return prisma.deal.update({ where: { id: dealId }, data });
}

// Удаление сделки вместе с её строками операций (откат балансов, как у переводов).
export async function deleteDealById(userIds, dealId) {
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal || !asIds(userIds).includes(deal.userId)) throw new Error('Сделка не найдена');
  const rows = await prisma.transaction.findMany({ where: { dealId } });
  const impactOf = (kind, accountAmount) =>
    kind === 'income' || kind === 'transfer_in' ? accountAmount : -accountAmount;
  await prisma.$transaction([
    prisma.transaction.deleteMany({ where: { dealId } }),
    ...rows.map((r) =>
      prisma.account.update({
        where: { id: r.accountId },
        data: { balance: { increment: -impactOf(r.kind, r.accountAmount) } },
      })
    ),
    prisma.deal.delete({ where: { id: dealId } }),
  ]);
  return true;
}

// --- Подсчёт ---

// Стоимость открытых сделок по пользователю (для снапшотов богатства, все юзеры)
export async function openDealsUsdByUser(rates) {
  const deals = await prisma.deal.findMany({ where: { status: 'open' }, select: { userId: true, symbol: true, qty: true } });
  const totals = new Map();
  for (const d of deals) {
    const rate = rates.get(d.symbol);
    if (typeof rate !== 'number') continue;
    totals.set(d.userId, (totals.get(d.userId) ?? 0) + d.qty * rate);
  }
  return totals;
}

// Сводка по открытым сделкам семьи: { usd, costUsd, pnlUsd, pnlPct }
export async function dealsStats(userIds, rates) {
  const deals = await prisma.deal.findMany({
    where: { userId: { in: asIds(userIds) }, status: 'open' },
    select: { symbol: true, qty: true, spentUsd: true },
  });
  let usd = 0;
  let costUsd = 0;
  for (const d of deals) {
    const rate = rates.get(d.symbol);
    if (typeof rate === 'number') usd += d.qty * rate;
    costUsd += d.spentUsd;
  }
  const pnlUsd = usd - costUsd;
  return { usd, costUsd, pnlUsd, pnlPct: costUsd > 0 ? (pnlUsd / costUsd) * 100 : null };
}

// Список для дашборда/бота: открытые (по дате создания) + последние закрытые.
// rates передаётся снаружи — тот же кэш, что у счетов (единая цена в сводке).
export async function listDeals(userIds, rates) {
  const ids = asIds(userIds);
  const [open, closed] = await Promise.all([
    prisma.deal.findMany({ where: { userId: { in: ids }, status: 'open' }, orderBy: { createdAt: 'desc' } }),
    prisma.deal.findMany({
      where: { userId: { in: ids }, status: 'closed' },
      orderBy: { closedAt: 'desc' },
      take: 10,
    }),
  ]);
  const shape = (d) => {
    const base = {
      id: d.id,
      symbol: d.symbol,
      qty: d.qty,
      spentAmount: d.spentAmount,
      spentCurrency: d.spentCurrency,
      spentUsd: d.spentUsd,
      buyPriceUsd: d.buyPriceUsd,
      status: d.status,
      alertUp: d.alertUp,
      alertDown: d.alertDown,
      note: d.note,
      createdAt: d.createdAt,
      closedAt: d.closedAt,
      proceedsAmount: d.proceedsAmount,
      proceedsCurrency: d.proceedsCurrency,
      proceedsUsd: d.proceedsUsd,
    };
    if (d.status === 'open') {
      const price = rates.get(d.symbol);
      const valueUsd = typeof price === 'number' ? d.qty * price : null;
      const pnlUsd = valueUsd != null ? valueUsd - d.spentUsd : null;
      return {
        ...base,
        price,
        valueUsd,
        pnlUsd,
        pnlPct: pnlUsd != null && d.spentUsd > 0 ? (pnlUsd / d.spentUsd) * 100 : null,
      };
    }
    const pnlUsd = d.proceedsUsd != null ? d.proceedsUsd - d.spentUsd : null;
    return {
      ...base,
      price: null,
      valueUsd: d.proceedsUsd,
      pnlUsd,
      pnlPct: pnlUsd != null && d.spentUsd > 0 ? (pnlUsd / d.spentUsd) * 100 : null,
    };
  };
  return [...open.map(shape), ...closed.map(shape)];
}

// --- Уведомления по порогам (одноразово на порог) ---

// send(telegramId, text) — доставка (бот); сбой доставки не мешает остальным.
export async function checkDealAlerts(send) {
  const deals = await prisma.deal.findMany({
    where: {
      status: 'open',
      OR: [{ alertUp: { not: null } }, { alertDown: { not: null } }],
    },
    include: { user: { select: { telegramId: true } } },
  });
  if (!deals.length) return 0;
  const rates = await getUsdRates();
  let sent = 0;
  for (const d of deals) {
    const price = rates.get(d.symbol);
    if (typeof price !== 'number' || !(d.buyPriceUsd > 0)) continue;
    const pct = (price / d.buyPriceUsd - 1) * 100;

    const hitUp = d.alertUp != null && pct >= d.alertUp && !d.notifiedUpAt;
    const hitDown = d.alertDown != null && pct <= -d.alertDown && !d.notifiedDownAt;
    if (!hitUp && !hitDown) continue;

    const pctTxt = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
    const dir = hitUp ? 'вырос' : 'упал';
    const threshold = hitUp ? `+${d.alertUp}%` : `−${d.alertDown}%`;
    const nowUsd = d.qty * price;
    const pnl = nowUsd - d.spentUsd;
    const text =
      `${hitUp ? '📈' : '📉'} ${d.symbol} ${dir} на ${pctTxt} от входа (порог ${threshold})\n` +
      `Вход: ${fmtPriceUsd(d.buyPriceUsd)} → сейчас: ${fmtPriceUsd(price)}\n` +
      `${fmtQty(d.qty)} ${d.symbol}: вложено ${fmtUsd(d.spentUsd)} → сейчас ${fmtUsd(nowUsd)} ` +
      `(${pnl >= 0 ? '+' : '−'}${fmtUsd(Math.abs(pnl))})` +
      (d.note ? `\n${d.note}` : '');
    try {
      await send(d.user.telegramId, text);
    } catch {
      continue; // не доставилось — флаг не ставим, попробуем в следующий час
    }
    sent++;
    await prisma.deal.update({
      where: { id: d.id },
      data: hitUp ? { notifiedUpAt: new Date() } : { notifiedDownAt: new Date() },
    });
  }
  return sent;
}
