// Личные финансы: счета (фиат + крипта корзины), траты/поступления одной строкой,
// сводка «богатею или беднею» и снимки богатства для графика.
// Семья (Household): все члены видят и правят общие счета; счета остаются у создателя.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { prisma } from './db.js';
import { CURRENCIES } from './config.js';
import { getUsdRates, toUsd } from './usrates.js';
import { dealsStats, openDealsUsdByUser } from './deals.js';

// Псевдонимы валют во вводе ('150 thb', '12.5 usd кофе', '0.01 btc', '100 рублей еда')
const CURRENCY_ALIASES = {
  usd: 'USD', $: 'USD', доллар: 'USD',
  rub: 'RUB', руб: 'RUB', рублей: 'RUB', рубля: 'RUB', р: 'RUB',
  thb: 'THB', бат: 'THB', батов: 'THB', baht: 'THB',
  trx: 'TRX', bnb: 'BNB', ton: 'TON', btc: 'BTC', eth: 'ETH', ltc: 'LTC',
};

export function normalizeCurrency(token) {
  const key = String(token ?? '').trim().toLowerCase();
  return CURRENCY_ALIASES[key] ?? (CURRENCIES.includes(key.toUpperCase()) ? key.toUpperCase() : null);
}

// '150 кофе' | '+50000 зарплата' | '12.5 usd кофе' | '0.01 btc' | '1,5к продукты' | '150 рублей еда'
// -> { kind: 'expense'|'income', amount, currency|null, description } | null (не похоже на сумму)
// Суффикс «к» умножает только вплотную к числу (1,5к); первое слово остатка может быть валютой.
const LINE_RE = /^([+-])?\s*(\d+(?:[.,]\d+)?)(к|k)?\s*(.+)?$/;

export function parseAmountLine(text) {
  const m = LINE_RE.exec(String(text ?? '').trim());
  if (!m) return null;
  const [, sign, num, kilo, rest] = m;
  let amount = Number(num.replace(',', '.'));
  if (kilo) amount *= 1000;
  if (!(amount > 0)) return null;

  let currency = null;
  let description = (rest ?? '').trim();
  const [first, ...tail] = description.split(/\s+/);
  if (first) {
    const guess = normalizeCurrency(first);
    if (guess) {
      currency = guess;
      description = tail.join(' ');
    }
  }
  return { kind: sign === '+' ? 'income' : 'expense', amount, currency, description };
}

// --- Семья: общий доступ к счетам ---

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const asIds = (x) => (Array.isArray(x) ? x : [x]);

// Создаёт Household, если пользователь ещё не в семье
export async function ensureHousehold(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { householdId: true } });
  if (user?.householdId) return prisma.household.findUnique({ where: { id: user.householdId } });
  const household = await prisma.household.create({ data: {} });
  await prisma.user.update({ where: { id: userId }, data: { householdId: household.id } });
  return household;
}

// id всех членов семьи пользователя (без семьи — только он сам)
export async function memberIds(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { householdId: true } });
  if (!user?.householdId) return [userId];
  const members = await prisma.user.findMany({ where: { householdId: user.householdId }, select: { id: true } });
  return members.map((m) => m.id);
}

export function householdMembers(userId) {
  return prisma.user
    .findUnique({ where: { id: userId }, select: { householdId: true } })
    .then((user) =>
      user?.householdId
        ? prisma.user.findMany({
            where: { householdId: user.householdId },
            orderBy: { createdAt: 'asc' },
            select: { id: true, firstName: true, username: true, photoUrl: true },
          })
        : []
    );
}

// Одноразовая ссылка-приглашение (действует 24ч), токен — hex без префикса
export async function createFamilyInvite(userId) {
  const household = await ensureHousehold(userId);
  await prisma.householdInvite.deleteMany({ where: { expiresAt: { lt: new Date() } } }); // ленивая чистка
  const token = randomBytes(24).toString('hex');
  await prisma.householdInvite.create({
    data: {
      tokenHash: sha256(token),
      householdId: household.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });
  return token;
}

// Вступление по deep-link токену: одноразовый, живёт 24ч, повторно в ту же семью — нельзя
export async function joinFamilyByToken(userId, token) {
  const record = await prisma.householdInvite.findUnique({ where: { tokenHash: sha256(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) return { ok: false, error: 'expired' };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { householdId: true } });
  if (user?.householdId === record.householdId) return { ok: false, error: 'already' };
  if (user?.householdId) return { ok: false, error: 'other' };
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { householdId: record.householdId } }),
    prisma.householdInvite.update({ where: { id: record.id }, data: { usedById: userId, usedAt: new Date() } }),
  ]);
  return { ok: true };
}

// Адресат приглашения по @username: только среди пользователей бота (Telegram не даёт
// искать по username глобально), не из этой семьи и не из другой.
// Возвращает { reason: 'invalid'|'not_found'|'already'|'other'|'ok', target? }
export async function resolveInviteTarget(inviterId, username) {
  const clean = String(username ?? '').replace(/^@/, '').trim();
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(clean)) return { reason: 'invalid' };
  const target = await prisma.user.findFirst({
    where: { username: { equals: clean, mode: 'insensitive' } },
  });
  if (!target) return { reason: 'not_found' };
  const household = await ensureHousehold(inviterId); // семья приглашающего создаётся при первом приглашении
  if (target.householdId === household.id) return { target, reason: 'already' };
  if (target.householdId) return { target, reason: 'other' };
  return { target, reason: 'ok' };
}

// --- Пользователь и счета ---

export async function ensureFinanceUser(from) {
  return prisma.user.upsert({
    where: { telegramId: String(from.id) },
    update: {
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
    },
    create: {
      telegramId: String(from.id),
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
    },
  });
}

// Счета пользователя или всей его семьи (владелец прилагается для подписей)
export async function listAccounts(userIds) {
  const rows = await prisma.account.findMany({
    where: { userId: { in: asIds(userIds) } },
    orderBy: [{ userId: 'asc' }, { isDefault: 'desc' }, { createdAt: 'asc' }],
    include: { user: { select: { firstName: true, username: true } } },
  });
  return rows.map(({ user, ...a }) => ({ ...a, ownerName: user.firstName || user.username || null }));
}

export async function createAccount(userId, name, currency, startAmount = 0, isSavings = false) {
  const count = await prisma.account.count({ where: { userId } });
  return prisma.account.create({
    data: { userId, name, currency, startAmount, balance: startAmount, isSavings, isDefault: count === 0 },
  });
}

export function deleteAccount(userIds, name) {
  return prisma.account.deleteMany({ where: { userId: { in: asIds(userIds) }, name } });
}

// Основной — только свой счёт (траты без валюты списываются со своего ⭐)
export async function setDefaultAccount(userId, accountId) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== userId) throw new Error('Основным можно назначить только свой счёт');
  await prisma.$transaction([
    prisma.account.updateMany({ where: { userId }, data: { isDefault: false } }),
    prisma.account.updateMany({ where: { userId, id: accountId }, data: { isDefault: true } }),
  ]);
}

// --- Сводка «богатею или беднею» ---

const VERDICT_THRESHOLD_PCT = 0.5;

function delta(totalUsd, baseUsd) {
  if (baseUsd == null || baseUsd === 0) return null;
  const usd = totalUsd - baseUsd;
  return { usd, pct: (usd / baseUsd) * 100 };
}

// Снапшот семьи на дату ≤ before: последний общий день, суммы по всем членам
// (снимки пишутся одновременно, дни совпадают; кто ещё не «фотографировался» — не входит)
async function familySnapshot(userIds, before) {
  const latest = await prisma.wealthSnapshot.findFirst({
    where: { userId: { in: asIds(userIds) }, day: { lte: before } },
    orderBy: { day: 'desc' },
  });
  if (!latest) return null;
  const rows = await prisma.wealthSnapshot.findMany({
    where: { userId: { in: asIds(userIds) }, day: latest.day },
  });
  return {
    totalUsd: rows.reduce((s, r) => s + r.totalUsd, 0),
    savingsUsd: rows.reduce((s, r) => s + r.savingsUsd, 0),
  };
}

export async function financeSummary(userIds) {
  const ids = asIds(userIds);
  const [accounts, rates] = await Promise.all([listAccounts(ids), getUsdRates()]);
  let totalUsd = 0;
  let savingsUsd = 0;
  const withUsd = [];
  for (const a of accounts) {
    const usd = typeof rates.get(a.currency) === 'number' ? a.balance * rates.get(a.currency) : null;
    if (usd != null) {
      totalUsd += usd;
      if (a.isSavings) savingsUsd += usd;
    }
    withUsd.push({ ...a, usd });
  }
  // открытые сделки-позиции: входят в «Всего» и «Текущие» (это те же деньги, но в крипте)
  const deals = await dealsStats(ids, rates);
  totalUsd += deals.usd;
  const currentUsd = totalUsd - savingsUsd;
  const now = Date.now();
  const [s7, s30] = await Promise.all([
    familySnapshot(ids, new Date(now - 7 * 86400e3)),
    familySnapshot(ids, new Date(now - 30 * 86400e3)),
  ]);
  // динамика по трём срезам: всего / текущие / накопления
  const total = {
    usd: totalUsd,
    d7: delta(totalUsd, s7?.totalUsd),
    d30: delta(totalUsd, s30?.totalUsd),
  };
  const current = {
    usd: currentUsd,
    d7: delta(currentUsd, s7 ? s7.totalUsd - s7.savingsUsd : null),
    d30: delta(currentUsd, s30 ? s30.totalUsd - s30.savingsUsd : null),
  };
  const savings = {
    usd: savingsUsd,
    d7: delta(savingsUsd, s7?.savingsUsd ?? null),
    d30: delta(savingsUsd, s30?.savingsUsd ?? null),
  };
  const verdictOf = (d) => {
    const trend = d.d7 ?? d.d30;
    if (!trend) return '—';
    return trend.pct > VERDICT_THRESHOLD_PCT ? 'богатеешь 📈'
      : trend.pct < -VERDICT_THRESHOLD_PCT ? 'беднеешь 📉'
      : 'без изменений';
  };
  total.verdict = verdictOf(total);
  const savingsTrend = savings.d7 ?? savings.d30;
  savings.verdict = !savingsTrend ? '—'
    : savingsTrend.pct > VERDICT_THRESHOLD_PCT ? 'копишь 🐷'
    : savingsTrend.pct < -VERDICT_THRESHOLD_PCT ? 'лезешь в накопления 📉'
    : 'без изменений';
  return { accounts: withUsd, total, current, savings, deals };
}

// --- Транзакции ---

// Сумма вводится в currency (или в валюте счёта), пересчёт в валюту счёта — через USD.
// userId — автор записи, ids — члены семьи с доступом к счёту (счёт может быть чужим).
export async function applyTransaction({ userId, ids, accountId, kind, amount, currency, description, excluded }) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || !asIds(ids ?? [userId]).includes(account.userId)) throw new Error('Счёт не найден');

  const txCurrency = currency ?? account.currency;
  const usd = await toUsd(amount, txCurrency);
  const rates = await getUsdRates();
  const accountRate = rates.get(account.currency);
  if (typeof accountRate !== 'number') throw new Error(`Нет курса для ${account.currency}`);
  const inAccount = txCurrency === account.currency ? amount : usd / accountRate;

  const [tx] = await prisma.$transaction([
    prisma.transaction.create({
      data: {
        userId,
        accountId,
        kind,
        amount,
        currency: txCurrency,
        usd,
        accountAmount: inAccount,
        excluded: Boolean(excluded),
        description: description || null,
      },
    }),
    prisma.account.update({
      where: { id: accountId },
      data: { balance: { increment: kind === 'income' ? inAccount : -inAccount } },
    }),
  ]);
  return { transaction: tx, account: await prisma.account.findUnique({ where: { id: accountId } }) };
}

// --- Правка/удаление с веб-редактора ---

export async function updateAccountFields(userIds, accountId, { name, balance, isSavings }) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || !asIds(userIds).includes(account.userId)) throw new Error('Счёт не найден');
  const data = {};
  if (name !== undefined) {
    const clean = String(name).trim().slice(0, 50);
    if (!clean) throw new Error('Имя счёта не может быть пустым');
    data.name = clean;
  }
  if (balance !== undefined) {
    const value = Number(balance);
    if (!Number.isFinite(value) || value < 0) throw new Error('Баланс должен быть числом ≥ 0');
    data.balance = value;
  }
  if (isSavings !== undefined) data.isSavings = Boolean(isSavings);
  return prisma.account.update({ where: { id: accountId }, data });
}

// Смена валюты счёта: баланс, стартовая сумма и accountAmount всех операций
// пересчитываются по текущему курсу (фактор newRate/oldRate) — линейное масштабирование
// сохраняет инвариант «баланс = стартовая + Σ влияний операций», откат при правке/удалении остаётся точным.
export async function changeAccountCurrency(userIds, accountId, newCurrency) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || !asIds(userIds).includes(account.userId)) throw new Error('Счёт не найден');
  if (!CURRENCIES.includes(newCurrency)) throw new Error(`Неизвестная валюта ${newCurrency}`);
  if (newCurrency === account.currency) return account;
  const rates = await getUsdRates();
  const oldRate = rates.get(account.currency);
  const newRate = rates.get(newCurrency);
  if (typeof oldRate !== 'number' || typeof newRate !== 'number') {
    throw new Error(`Нет курса для ${typeof oldRate !== 'number' ? account.currency : newCurrency}`);
  }
  const factor = oldRate / newRate; // сумма_новая = сумма_старая * oldRate / newRate (через USD)
  await prisma.$transaction([
    prisma.account.update({
      where: { id: accountId },
      data: {
        currency: newCurrency,
        balance: account.balance * factor,
        startAmount: account.startAmount * factor,
      },
    }),
    prisma.transaction.updateMany({
      where: { accountId },
      data: { accountAmount: { multiply: factor } },
    }),
  ]);
  return prisma.account.findUnique({ where: { id: accountId } });
}

export async function deleteAccountById(userIds, accountId) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || !asIds(userIds).includes(account.userId)) throw new Error('Счёт не найден');
  await prisma.account.delete({ where: { id: accountId } }); // транзакции уйдут каскадом
  return true;
}

const impactOf = (kind, accountAmount) =>
  kind === 'income' || kind === 'transfer_in' ? accountAmount : -accountAmount;

const isTransferKind = (kind) => kind === 'transfer_out' || kind === 'transfer_in';

// --- Переводы между счетами (в т.ч. членам семьи, с конвертацией через USD) ---

// Пара строк transfer_out/transfer_in с общим transferId; богатство семьи не меняет.
// toAmount — фактическая сумма зачисления в валюте счёта «куда» (реальный курс/комиссии);
// не задана — зачисление по рыночному кроссу через USD.
export async function applyTransfer({ userId, ids, fromAccountId, toAccountId, amount, currency, description, toAmount }) {
  if (fromAccountId === toAccountId) throw new Error('Счета должны различаться');
  const famIds = asIds(ids ?? [userId]);
  const [from, to] = await Promise.all([
    prisma.account.findUnique({ where: { id: fromAccountId } }),
    prisma.account.findUnique({ where: { id: toAccountId } }),
  ]);
  if (!from || !famIds.includes(from.userId)) throw new Error('Счёт списания не найден');
  if (!to || !famIds.includes(to.userId)) throw new Error('Счёт зачисления не найден');
  if (!(amount > 0)) throw new Error('Сумма должна быть > 0');
  if (toAmount != null && !(toAmount > 0)) throw new Error('Сумма зачисления должна быть числом > 0');

  const rates = await getUsdRates();
  const txCurrency = currency ?? from.currency;
  if (!CURRENCIES.includes(txCurrency)) throw new Error(`Неизвестная валюта ${txCurrency}`);
  const usd = await toUsd(amount, txCurrency);
  const fromRate = rates.get(from.currency);
  const toRate = rates.get(to.currency);
  if (typeof fromRate !== 'number') throw new Error(`Нет курса для ${from.currency}`);
  if (typeof toRate !== 'number') throw new Error(`Нет курса для ${to.currency}`);
  const outAmount = txCurrency === from.currency ? amount : usd / fromRate;
  const inAmount = toAmount != null ? toAmount : txCurrency === to.currency ? amount : usd / toRate;
  const usdIn = inAmount * toRate;
  if (outAmount > from.balance) {
    throw new Error(`Недостаточно средств: на счёте «${from.name}» ${from.balance} ${from.currency}`);
  }

  const transferId = randomUUID();
  await prisma.$transaction([
    prisma.transaction.create({
      data: {
        userId,
        accountId: from.id,
        kind: 'transfer_out',
        amount,
        currency: txCurrency,
        usd,
        accountAmount: outAmount,
        description: description || null,
        transferId,
      },
    }),
    prisma.transaction.create({
      data: {
        userId,
        accountId: to.id,
        kind: 'transfer_in',
        amount: inAmount,
        currency: to.currency,
        usd: usdIn,
        accountAmount: inAmount,
        description: description || null,
        transferId,
      },
    }),
    prisma.account.update({ where: { id: from.id }, data: { balance: { decrement: outAmount } } }),
    prisma.account.update({ where: { id: to.id }, data: { balance: { increment: inAmount } } }),
  ]);
  return {
    from: await prisma.account.findUnique({ where: { id: from.id } }),
    to: await prisma.account.findUnique({ where: { id: to.id } }),
  };
}

export async function deleteTransactionById(userIds, txId) {
  const tx = await prisma.transaction.findUnique({ where: { id: txId } });
  if (!tx || !asIds(userIds).includes(tx.userId)) throw new Error('Операция не найдена');
  // перевод: удаляем пару целиком и откатываем оба счёта
  if (tx.transferId) {
    const pair = await prisma.transaction.findMany({ where: { transferId: tx.transferId } });
    await prisma.$transaction([
      prisma.transaction.deleteMany({ where: { transferId: tx.transferId } }),
      ...pair.map((p) =>
        prisma.account.update({
          where: { id: p.accountId },
          data: { balance: { increment: -impactOf(p.kind, p.accountAmount) } },
        })
      ),
    ]);
    return true;
  }
  // строки сделки управляются из раздела «Сделки» — балансы откатываются там же
  if (tx.dealId) throw new Error('Строки сделки удаляются вместе со сделкой — раздел «Сделки»');
  // откат влияния на баланс счёта
  await prisma.$transaction([
    prisma.transaction.delete({ where: { id: txId } }),
    prisma.account.update({
      where: { id: tx.accountId },
      data: { balance: { increment: -impactOf(tx.kind, tx.accountAmount) } },
    }),
  ]);
  return true;
}

export async function updateTransactionById(userIds, txId, { kind, amount, currency, description, excluded }) {
  const tx = await prisma.transaction.findUnique({ where: { id: txId } });
  if (!tx || !asIds(userIds).includes(tx.userId)) throw new Error('Операция не найдена');
  if (tx.transferId || isTransferKind(tx.kind)) throw new Error('Переводы нельзя править — только удалить');
  if (tx.dealId) throw new Error('Строки сделки нельзя править — управление в разделе «Сделки»');
  const account = await prisma.account.findUnique({ where: { id: tx.accountId } });
  if (!account) throw new Error('Счёт не найден');

  const newKind = kind ?? tx.kind;
  const newAmount = amount ?? tx.amount;
  const newCurrency = currency ?? tx.currency;
  if (!(newAmount > 0)) throw new Error('Сумма должна быть > 0');
  if (!CURRENCIES.includes(newCurrency)) throw new Error(`Неизвестная валюта ${newCurrency}`);

  const usd = await toUsd(newAmount, newCurrency);
  const rates = await getUsdRates();
  const accountRate = rates.get(account.currency);
  if (typeof accountRate !== 'number') throw new Error(`Нет курса для ${account.currency}`);
  const inAccount = newCurrency === account.currency ? newAmount : usd / accountRate;

  const balanceDelta = impactOf(newKind, inAccount) - impactOf(tx.kind, tx.accountAmount);
  const [updated] = await prisma.$transaction([
    prisma.transaction.update({
      where: { id: txId },
      data: {
        kind: newKind,
        amount: newAmount,
        currency: newCurrency,
        usd,
        accountAmount: inAccount,
        excluded: excluded !== undefined ? Boolean(excluded) : undefined,
        description: description !== undefined ? description || null : undefined,
      },
    }),
    prisma.account.update({ where: { id: account.id }, data: { balance: { increment: balanceDelta } } }),
  ]);
  return updated;
}

// --- Снимки богатства (одна точка на день, upsert) ---

export async function collectWealthSnapshots() {
  const accounts = await prisma.account.findMany();
  if (accounts.length === 0) return 0;
  const rates = await getUsdRates();
  const totals = new Map();
  for (const a of accounts) {
    const rate = rates.get(a.currency);
    if (typeof rate !== 'number') continue;
    const usd = a.balance * rate;
    const t = totals.get(a.userId) ?? { totalUsd: 0, savingsUsd: 0 };
    t.totalUsd += usd;
    if (a.isSavings) t.savingsUsd += usd;
    totals.set(a.userId, t);
  }
  // открытые сделки-позиции — часть богатства (график видит рыночные движения)
  for (const [userId, usd] of await openDealsUsdByUser(rates)) {
    const t = totals.get(userId) ?? { totalUsd: 0, savingsUsd: 0 };
    t.totalUsd += usd;
    totals.set(userId, t);
  }
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  for (const [userId, t] of totals) {
    await prisma.wealthSnapshot.upsert({
      where: { userId_day: { userId, day } },
      update: { totalUsd: t.totalUsd, savingsUsd: t.savingsUsd },
      create: { userId, day, totalUsd: t.totalUsd, savingsUsd: t.savingsUsd },
    });
  }
  return totals.size;
}

// --- Отложенный выбор счёта (несколько счетов → inline-кнопки) ---

const PENDING_TTL_MS = 10 * 60 * 1000;
const pending = new Map(); // telegramId -> { kind, amount, currency, description, accountIds, expiresAt }

export function setPendingChoice(telegramId, data) {
  pending.set(String(telegramId), { ...data, expiresAt: Date.now() + PENDING_TTL_MS });
}

export function takePendingChoice(telegramId) {
  const now = Date.now();
  for (const [key, value] of pending) {
    if (value.expiresAt < now) pending.delete(key);
  }
  const data = pending.get(String(telegramId));
  if (data) pending.delete(String(telegramId));
  return data ?? null;
}
