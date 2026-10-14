// Веб-сервер: страница входа, дашборд с графиками, API.
import express from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_URL, SESSION_TTL_DAYS, BOT_TOKEN, WINDOWS, DEFAULT_WINDOW, COINS, FIAT, GLM_API_KEY, GLM_MODEL, ADMIN_USERNAMES, CURRENCIES } from './config.js';
import { createLoginToken, consumeLoginToken, upsertUserFromTelegram, createSession, getSessionUser, deleteSession } from './auth.js';
import { getHistorySeries, getPriceSeries, getPeriodStats } from './history.js';
import { getBasketPrices, getFiatRates } from './rates.js';
import { getUsdRates } from './usrates.js';
import {
  memberIds,
  householdMembers,
  createFamilyInvite,
  resolveInviteTarget,
  financeSummary,
  createAccount,
  updateAccountFields,
  changeAccountCurrency,
  deleteAccountById,
  setDefaultAccount,
  applyTransaction,
  applyTransfer,
  updateTransactionById,
  deleteTransactionById,
} from './finance.js';
import { applyDealBuy, closeDeal, updateDealById, deleteDealById, listDeals, DEAL_SYMBOLS } from './deals.js';
import { analyzeBasket } from './glm.js';
import { prisma } from './db.js';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), 'web');
const ECHARTS_PATH = join(WEB_DIR, 'vendor', 'echarts.min.js');
const SESSION_COOKIE = 'rui_session';

const RANGE_HOURS = { '24h': 24, '7d': 168, '30d': 720, all: null };
// Диапазоны ретроспективы из дневных цен (дни; null = всё)
const HISTORY_RANGE_DAYS = { '30d': 30, '180d': 180, '1y': 365, all: null };
// Раздел FIAT: своя мапа диапазонов (история фиата = 365 дней с market_chart)
const FIAT_RANGE_DAYS = { '7d': 7, '30d': 30, '180d': 180, '1y': 365 };
const isFiatSet = (req) => req.query.set === 'fiat';
// Свежесть ИИ-отчёта для повторного использования (данные меняются раз в день)
const AI_REPORT_TTL_MS = 12 * 60 * 60 * 1000;
// Стабильный порядок серий на графике
const SYMBOL_ORDER = COINS.map((c) => c.symbol);
const round2 = (x) => Math.round(x * 100) / 100;
const roundPrice = (x) => (x == null ? null : Number(x.toPrecision(6)));

async function page(name) {
  return readFile(join(WEB_DIR, name), 'utf8');
}

export function createServer({ botUsername, onFamilyInvite }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(compression()); // графики отдают до 200KB JSON — gzip режет ~70%
  app.use(express.json());
  app.use(cookieParser());

  // --- Публичные ---

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Вызов из бота: выдать одноразовый токен входа. Shared secret = BOT_TOKEN.
  app.post('/api/auth/bot-login', async (req, res) => {
    try {
      const body = req.body ?? {};
      if (body.token !== BOT_TOKEN || !body.id) {
        return res.status(403).json({ error: 'forbidden' });
      }
      // заблокированным вход в дашборд не выдаём
      const blocked = await prisma.user.findUnique({
        where: { telegramId: String(body.id) },
        select: { isBlocked: true },
      });
      if (blocked?.isBlocked) return res.status(403).json({ error: 'blocked' });
      const loginToken = await createLoginToken(body);
      res.json({ loginToken, loginUrl: `${APP_URL}/login/callback?token=${loginToken}` });
    } catch (err) {
      console.error('[server] bot-login:', err.message ?? err);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/login/callback', async (req, res) => {
    try {
      const record = await consumeLoginToken(String(req.query.token ?? ''));
      if (!record) return res.redirect('/login?error=token');
      const user = await upsertUserFromTelegram(record);
      if (user.isBlocked) return res.redirect('/login?error=blocked');
      const sessionToken = await createSession(user.id, SESSION_TTL_DAYS);
      res.cookie(SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: APP_URL.startsWith('https'),
        maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
        path: '/',
      });
      res.redirect('/');
    } catch (err) {
      console.error('[server] login/callback:', err.message ?? err);
      res.redirect('/login?error=internal');
    }
  });

  app.get('/login', async (req, res) => {
    const html = (await page('login.html'))
      .replaceAll('%BOT_USERNAME%', botUsername)
      .replaceAll('%HAS_ERROR%', req.query.error ? 'block' : 'none');
    res.type('html').send(html);
  });

  // --- Сессии ---

  // Блокированный пользователь: сессии удаляем, он «не вошёл».
  // Админ-права из ADMIN_USERNAMES восстанавливаем на лету (не ждать нового входа).
  // lastSeenAt обновляем не чаще раза в минуту (дашборд поллит API каждые 60с).
  app.use(async (req, res, next) => {
    const user = await getSessionUser(req.cookies?.[SESSION_COOKIE]);
    if (user?.isBlocked) {
      await prisma.session.deleteMany({ where: { userId: user.id } }).catch(() => {});
      req.user = null;
      return next();
    }
    if (user) {
      if (!user.isAdmin && ADMIN_USERNAMES.includes((user.username ?? '').toLowerCase())) {
        await prisma.user.update({ where: { id: user.id }, data: { isAdmin: true } }).catch(() => {});
        user.isAdmin = true;
      }
      if (!user.lastSeenAt || Date.now() - user.lastSeenAt.getTime() > 60_000) {
        prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
      }
    }
    req.user = user;
    next();
  });

  const requireAuth = (req, res, next) => {
    if (req.user) return next();
    res.status(401).json({ error: 'unauthorized' });
  };

  const requireAdmin = (req, res, next) => {
    if (req.user?.isAdmin) return next();
    res.status(403).json({ error: 'forbidden' });
  };

  app.post('/api/auth/logout', async (req, res) => {
    await deleteSession(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    const { id, username, firstName, photoUrl, isAdmin } = req.user;
    res.json({ id, username, firstName, photoUrl, isAdmin: Boolean(isAdmin) });
  });

  // Текущие курсы для калькулятора обмена: крипты + фиат, единиц за 1 USD
  // (источники кэшированы в rates.js — запрос дешёвый)
  app.get('/api/rates', requireAuth, async (req, res) => {
    try {
      const [coins, fiat] = await Promise.all([getBasketPrices(), getFiatRates()]);
      const rates = { USD: 1 };
      for (const { symbol, price } of coins) rates[symbol] = price;
      for (const [symbol, rate] of Object.entries(fiat)) {
        if (rate != null) rates[symbol] = rate;
      }
      res.json({ rates });
    } catch (err) {
      console.error('[server] rates:', err.message ?? err);
      res.status(502).json({ error: 'rates_unavailable' });
    }
  });

  app.get('/api/snapshots', requireAuth, async (req, res) => {
    try {
      const window = WINDOWS[req.query.window] ? req.query.window : DEFAULT_WINDOW;
      const rangeHours = RANGE_HOURS[req.query.range] === undefined ? RANGE_HOURS['7d'] : RANGE_HOURS[req.query.range];
      const metric = req.query.metric === 'r' ? 'r' : req.query.metric === 'rui' ? 'rui' : null;
      const where = { window };
      if (rangeHours) where.ts = { gte: new Date(Date.now() - rangeHours * 60 * 60 * 1000) };

      const rows = await prisma.snapshot.findMany({ where, orderBy: { ts: 'asc' } });

      const ts = [];
      const mean = [];
      const bySymbol = new Map();
      for (const row of rows) {
        const key = row.ts.getTime();
        if (!ts.length || ts[ts.length - 1] !== key) {
          ts.push(key);
          mean.push(round2(row.mean));
        }
        let series = bySymbol.get(row.symbol);
        if (!series) {
          series = { symbol: row.symbol, ...(metric !== 'r' && { rui: [] }), ...(metric !== 'rui' && { r: [] }) };
          bySymbol.set(row.symbol, series);
        }
        if (metric !== 'r') series.rui.push(round2(row.rui));
        if (metric !== 'rui') series.r.push(round2(row.r));
      }
      // стабильный порядок независимо от порядка строк в БД
      const series = [...bySymbol.values()].sort(
        (a, b) => SYMBOL_ORDER.indexOf(a.symbol) - SYMBOL_ORDER.indexOf(b.symbol)
      );
      res.json({ window, ts, mean, series });
    } catch (err) {
      console.error('[server] snapshots:', err.message ?? err);
      res.status(500).json({ error: 'internal' });
    }
  });

  // Сводка «сейчас» для таблицы: live-снапшот по окну (короткие диапазоны)
  // или R/RUI за выбранный период из дневных цен (180д/1г/5л и режим цены).
  app.get('/api/summary', requireAuth, async (req, res) => {
    try {
      const window = WINDOWS[req.query.window] ? req.query.window : DEFAULT_WINDOW;
      // фиат всегда считается из дневных цен за период (живых снапшотов нет)
      const retroDays = isFiatSet(req)
        ? FIAT_RANGE_DAYS[req.query.range] ?? 30
        : HISTORY_RANGE_DAYS[req.query.range];

      if (retroDays !== undefined) {
        const stats = await getPeriodStats(retroDays, isFiatSet(req) ? FIAT : undefined);
        if (!stats) return res.json({ mode: 'period', from: null, to: null, mean: null, items: [] });
        const items = stats.items
          .map(({ symbol, endPrice: price, r, rui }) => ({ symbol, price, r, rui }))
          .sort((a, b) => b.rui - a.rui);
        return res.json({ mode: 'period', from: stats.from, to: stats.to, mean: round2(stats.mean), items });
      }

      // live: последний снапшот по окну + текущие цены
      const last = await prisma.snapshot.findFirst({ where: { window }, orderBy: { ts: 'desc' } });
      if (!last) return res.json({ mode: 'live', window, ts: null, mean: null, items: [] });
      const rows = await prisma.snapshot.findMany({ where: { window, ts: last.ts } });
      const latestPrices = new Map();
      for (const coin of COINS) {
        const p = await prisma.price.findFirst({
          where: { symbol: coin.symbol },
          orderBy: { date: 'desc' },
        });
        if (p) latestPrices.set(coin.symbol, p.price);
      }
      const items = rows
        .map(({ symbol, r, rui }) => ({
          symbol,
          price: roundPrice(latestPrices.get(symbol)),
          r: round2(r),
          rui: round2(rui),
        }))
        .sort((a, b) => b.rui - a.rui);
      res.json({ mode: 'live', window, ts: last.ts, mean: round2(last.mean), items });
    } catch (err) {
      console.error('[server] summary:', err.message ?? err);
      res.status(500).json({ error: 'internal' });
    }
  });

  // ИИ-аналитика периода: собираем контекст из БД и отдаём GLM с веб-поиском.
  // Свежий отчёт для той же пары (window, range) переиспользуется — без дублей запросов.
  app.post('/api/ai/analyze', requireAuth, async (req, res) => {
    try {
      if (!GLM_API_KEY) return res.status(503).json({ error: 'ai_disabled' });
      const set = req.body?.set === 'fiat' ? 'fiat' : 'coin';
      const range = String(req.body?.range ?? '');
      const extra = String(req.body?.extra ?? '').trim().slice(0, 500);

      let window;
      let days;
      let symbols; // undefined = корзина COIN (дефолт history.js)
      if (set === 'fiat') {
        window = '';
        days = FIAT_RANGE_DAYS[range] ?? 30;
        symbols = FIAT;
      } else {
        window = WINDOWS[req.body?.window] ? req.body.window : DEFAULT_WINDOW;
        const retroDays = HISTORY_RANGE_DAYS[range];
        days = retroDays !== undefined ? retroDays : WINDOWS[window];
      }

      // кэш: отчёту младше TTL доверяем (данные внутри дня не меняются);
      // ключ включает раздел (coin/fiat) и доп. указание — с ними отдельные отчёты
      const cachedReport = await prisma.aiReport.findFirst({
        where: { set, window, range, extra: extra || null },
        orderBy: { createdAt: 'desc' },
      });
      if (cachedReport && Date.now() - cachedReport.createdAt.getTime() < AI_REPORT_TTL_MS) {
        return res.json({
          cached: true,
          text: cachedReport.text,
          model: cachedReport.model,
          period: `с ${cachedReport.periodFrom} по ${cachedReport.periodTo}`,
          createdAt: cachedReport.createdAt,
        });
      }

      const stats = await getPeriodStats(days, symbols);
      if (!stats || stats.items.length < 2) {
        return res.status(400).json({ error: 'no_data' });
      }

      const period = `с ${stats.from} по ${stats.to}`;
      const laggards = stats.items.filter((it) => it.rui > 0).sort((a, b) => b.rui - a.rui);
      const leaders = stats.items.filter((it) => it.rui < 0).sort((a, b) => a.rui - b.rui);
      let prompt;
      if (set === 'fiat') {
        // курс показываем в привычном виде «единиц за $1» (в Price — USD за единицу)
        const fx = (p) => (1 / p).toFixed(2);
        const table = stats.items
          .map(
            (it) =>
              `- ${it.symbol}: курс ${fx(it.startPrice)} → ${fx(it.endPrice)} ед./$ (к доллару ${it.r >= 0 ? '+' : ''}${it.r}%), ` +
              `min ${fx(it.minPrice)} / max ${fx(it.maxPrice)}, RUI ${it.rui >= 0 ? '+' : ''}${it.rui}%`
          )
          .join('\n');
        prompt =
          `Проанализируй период ${period} на рынке фиатных валют.\n\n` +
          `Корзина из ${FIAT.length} валют (${FIAT.join(', ')}); курс — единиц за 1 доллар (рост курса = валюта дешевеет к доллару). ` +
          `R — доходность валюты в долларах (плюс = укрепилась). Средняя корзины M = ` +
          `${stats.mean >= 0 ? '+' : ''}${round2(stats.mean)}%. ` +
          `RUI = M − R: положительный — валюта отстала (недооценена), отрицательный — опережает.\n\n` +
          `Данные за период:\n${table}\n\n` +
          `Задача:\n` +
          `1. Кратко (2-3 предложения): что происходило с рублём, батом и воной против доллара.\n` +
          `2. По каждой валюте с заметным RUI (отстающие: ${laggards.slice(0, 2).map((i) => i.symbol).join(', ') || '—'}; ` +
          `лидеры: ${leaders.slice(0, 2).map((i) => i.symbol).join(', ') || '—'}): найди через поиск конкретные причины — ` +
          `ключевые ставки и политика ЦБ РФ, Bank of Thailand, Bank of Korea, решения ФРС, нефть и газ, санкции, потоки капитала, ` +
          `туризм и сезонность бата, экспорт и курсовая политика Кореи.\n` +
          `3. Итог: 2-3 пункта, на что смотреть дальше.\n` +
          (extra ? `\nДополнительное указание пользователя (приоритетное): ${extra}\n` : '') +
          `Сегодняшняя дата: ${new Date().toISOString().slice(0, 10)}.`;
      } else {
        const table = stats.items
          .map(
            (it) =>
              `- ${it.symbol}: $${it.startPrice} → $${it.endPrice} (${it.r >= 0 ? '+' : ''}${it.r}%), ` +
              `min $${it.minPrice} / max $${it.maxPrice}, RUI ${it.rui >= 0 ? '+' : ''}${it.rui}%`
          )
          .join('\n');
        prompt =
          `Проанализируй период ${period} на крипторынке.\n\n` +
          `Корзина из 6 монет (TRX, BNB, TON, BTC, ETH, LTC). Средняя доходность корзины M = ` +
          `${stats.mean >= 0 ? '+' : ''}${round2(stats.mean)}%. ` +
          `RUI = M − R: положительный — монета отстала от корзины, отрицательный — опережает.\n\n` +
          `Данные за период:\n${table}\n\n` +
          `Задача:\n` +
          `1. Кратко (2-3 предложения): что происходило с корзиной в целом и с рынком.\n` +
          `2. По каждой монете с заметным RUI (отстающие: ${laggards.slice(0, 2).map((i) => i.symbol).join(', ') || '—'}; ` +
          `лидеры: ${leaders.slice(0, 2).map((i) => i.symbol).join(', ') || '—'}): найди через поиск конкретные причины — ` +
          `новости, обновления сетей, листинги/делистинги, регуляторика, макрофон.\n` +
          `3. Итог: 2-3 пункта, на что смотреть дальше.\n` +
          (extra ? `\nДополнительное указание пользователя (приоритетное): ${extra}\n` : '') +
          `Сегодняшняя дата: ${new Date().toISOString().slice(0, 10)}.`;
      }

      const { text, usage } = await analyzeBasket(prompt);
      const saved = await prisma.aiReport.create({
        data: {
          set,
          window,
          range,
          extra: extra || null,
          periodFrom: stats.from,
          periodTo: stats.to,
          text,
          model: GLM_MODEL,
          userId: req.user.id,
          tokensIn: usage?.in ?? 0,
          tokensOut: usage?.out ?? 0,
        },
      });
      res.json({ cached: false, text, model: GLM_MODEL, period, createdAt: saved.createdAt });
    } catch (err) {
      console.error('[server] ai/analyze:', err.message ?? err);
      const status = err.status ?? 502;
      res.status(status).json({ error: err.status === 503 ? 'ai_disabled' : 'ai_error' });
    }
  });

  // Архив отчётов: список (без текста) и полный отчёт по id. set=fiat — отчёты раздела FIAT
  app.get('/api/ai/reports', requireAuth, async (req, res) => {
    try {
      const set = isFiatSet(req) ? 'fiat' : 'coin';
      const rows = await prisma.aiReport.findMany({
        where: { set },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          set: true,
          window: true,
          range: true,
          extra: true,
          periodFrom: true,
          periodTo: true,
          model: true,
          createdAt: true,
        },
      });
      res.json({ reports: rows });
    } catch (err) {
      console.error('[server] ai/reports:', err.message ?? err);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/ai/reports/:id', requireAuth, async (req, res) => {
    try {
      const report = await prisma.aiReport.findUnique({ where: { id: req.params.id } });
      if (!report) return res.status(404).json({ error: 'not_found' });
      res.json(report);
    } catch (err) {
      console.error('[server] ai/reports/:id:', err.message ?? err);
      res.status(500).json({ error: 'internal' });
    }
  });

  // Личные финансы/семья: счета, сводка «богатею или беднею», серия богатства и последние транзакции
  app.get('/api/finance', requireAuth, async (req, res) => {
    try {
      const userId = req.user.id;
      const ids = await memberIds(userId);
      const [summary, snapshots, txTotal, members, rates] = await Promise.all([
        financeSummary(ids),
        prisma.wealthSnapshot.findMany({
          where: { userId: { in: ids } },
          orderBy: { day: 'asc' },
          select: { day: true, totalUsd: true },
        }),
        prisma.transaction.count({ where: { userId: { in: ids } } }),
        householdMembers(userId),
        getUsdRates(),
      ]);
      // Пагинация «Последних операций»: 20 на страницу, txPage клэмпится к диапазону
      const txLimit = 20;
      const txPages = Math.max(1, Math.ceil(txTotal / txLimit));
      const txPage = Math.min(Math.max(0, Number(req.query.txPage) || 0), txPages - 1);
      const transactions = await prisma.transaction.findMany({
        where: { userId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        skip: txPage * txLimit,
        take: txLimit,
        include: {
          account: { select: { name: true, currency: true } },
          user: { select: { firstName: true, username: true } },
        },
      });
      // график богатства: сумма по членам семьи на каждый день
      const byDay = new Map();
      for (const s of snapshots) {
        const key = s.day.getTime();
        byDay.set(key, (byDay.get(key) ?? 0) + s.totalUsd);
      }
      res.json({
        accounts: summary.accounts.map(({ id, userId: ownerId, ownerName, name, currency, balance, isDefault, isSavings, usd }) => ({
          id,
          ownerId,
          ownerName,
          name,
          currency,
          balance,
          isDefault,
          isSavings,
          usd,
        })),
        total: summary.total,
        current: summary.current,
        savings: summary.savings,
        deals: {
          ...summary.deals,
          list: await listDeals(ids, rates),
        },
        members: members.map((m) => ({
          id: m.id,
          name: m.firstName || m.username || '—',
          photoUrl: m.photoUrl,
        })),
        rates: Object.fromEntries(rates), // для конвертации при смене валюты счёта
        ts: [...byDay.keys()],
        wealth: [...byDay.values()], // график богатства (по дням, сумма семьи)
        txPage,
        txPages,
        txTotal,
        transactions: transactions.map((t) => ({
          id: Number(t.id),
          accountId: t.accountId,
          kind: t.kind,
          amount: t.amount,
          currency: t.currency,
          usd: t.usd,
          excluded: t.excluded,
          description: t.description,
          transferId: t.transferId,
          dealId: t.dealId,
          createdAt: t.createdAt,
          accountName: t.account.name,
          accountCurrency: t.account.currency,
          accountAmount: t.accountAmount,
          authorName: t.user.firstName || t.user.username || null,
        })),
      });
    } catch (err) {
      console.error('[server] finance:', err.message ?? err);
      res.status(500).json({ error: 'internal' });
    }
  });

  // Мини-график трат: сумма expense по дням в USD (на момент ввода), вся семья.
  // Дни без трат — нули: непрерывная ось для баров и плавающей средней.
  app.get('/api/finance/spending', requireAuth, async (req, res) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 90);
      const ids = await memberIds(req.user.id);
      const fromDate = new Date(Date.now() - days * 86_400_000);
      const rows = await prisma.transaction.findMany({
        where: { userId: { in: ids }, kind: 'expense', excluded: false, createdAt: { gte: fromDate } },
        select: { createdAt: true, usd: true },
      });
      const byDay = new Map();
      for (const t of rows) {
        const d = new Date(t.createdAt);
        d.setUTCHours(0, 0, 0, 0);
        byDay.set(d.getTime(), (byDay.get(d.getTime()) ?? 0) + t.usd);
      }
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const ts = [];
      const sum = [];
      for (let i = days - 1; i >= 0; i--) {
        const day = today.getTime() - i * 86_400_000;
        ts.push(day);
        sum.push(Math.round((byDay.get(day) ?? 0) * 100) / 100);
      }
      res.json({ ts, sum });
    } catch (err) {
      console.error('[server] finance/spending:', err.message ?? err);
      res.status(500).json({ error: 'internal' });
    }
  });

  // --- Администрирование ---

  // Все пользователи: активность, счета/операции, расходы на AI-аналитику
  app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
      const [users, ai] = await Promise.all([
        prisma.user.findMany({
          orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
          include: { _count: { select: { accounts: true, transactions: true, sessions: true } } },
        }),
        prisma.aiReport.groupBy({
          by: ['userId'],
          _sum: { tokensIn: true, tokensOut: true },
          _count: true,
        }),
      ]);
      const aiByUser = new Map(ai.map((a) => [a.userId, a]));
      res.json({
        users: users.map((u) => {
          const a = aiByUser.get(u.id);
          return {
            id: u.id,
            username: u.username,
            firstName: u.firstName,
            lastName: u.lastName,
            telegramId: u.telegramId,
            isAdmin: u.isAdmin,
            isBlocked: u.isBlocked,
            createdAt: u.createdAt,
            lastSeenAt: u.lastSeenAt,
            counts: {
              accounts: u._count.accounts,
              transactions: u._count.transactions,
              sessions: u._count.sessions,
            },
            ai: {
              reports: a?._count ?? 0,
              tokensIn: a?._sum.tokensIn ?? 0,
              tokensOut: a?._sum.tokensOut ?? 0,
            },
          };
        }),
        totals: {
          users: users.length,
          blocked: users.filter((u) => u.isBlocked).length,
          reports: ai.reduce((s, a) => s + a._count, 0),
          tokensIn: ai.reduce((s, a) => s + (a._sum.tokensIn ?? 0), 0),
          tokensOut: ai.reduce((s, a) => s + (a._sum.tokensOut ?? 0), 0),
        },
      });
    } catch (err) {
      console.error('[server] admin/users:', err.message ?? err);
      res.status(500).json({ error: 'internal' });
    }
  });

  // Блокировка: сессии сносятся сразу — открытый дашборд «умирает» на следующем запросе
  const setUserBlocked = async (req, res, isBlocked) => {
    try {
      const target = await prisma.user.findUnique({ where: { id: req.params.id } });
      if (!target) return res.status(404).json({ error: 'not_found' });
      if (target.id === req.user.id) return res.status(400).json({ error: 'Себя заблокировать нельзя' });
      if (target.isAdmin) return res.status(400).json({ error: 'Администратора заблокировать нельзя' });
      await prisma.user.update({ where: { id: target.id }, data: { isBlocked } });
      if (isBlocked) await prisma.session.deleteMany({ where: { userId: target.id } });
      res.json({ ok: true });
    } catch (err) {
      console.error('[server] admin/block:', err.message ?? err);
      res.status(500).json({ error: 'internal' });
    }
  };
  app.post('/api/admin/users/:id/block', requireAuth, requireAdmin, (req, res) => setUserBlocked(req, res, true));
  app.post('/api/admin/users/:id/unblock', requireAuth, requireAdmin, (req, res) => setUserBlocked(req, res, false));

  // --- Личные финансы: редактор ---

  // Приглашение в семью по @username: бот доставляет сообщение адресату лично.
  // Если человек ещё не запускал бота (или бот у него заблокирован) — отдаём ссылку для ручной отправки.
  app.post('/api/family/invite', requireAuth, async (req, res) => {
    try {
      const username = String(req.body?.username ?? '').replace(/^@/, '').trim();
      const resolved = await resolveInviteTarget(req.user.id, username);
      if (resolved.reason === 'invalid') {
        return res.status(400).json({ error: 'Укажите username Telegram — например, @yuliya' });
      }
      if (resolved.reason === 'already') return res.status(400).json({ error: `@${username} уже в вашей семье` });
      if (resolved.reason === 'other') return res.status(400).json({ error: `@${username} уже состоит в другой семье` });

      const token = await createFamilyInvite(req.user.id);
      const url = `https://t.me/${botUsername}?start=fam_${token}`;
      if (resolved.reason === 'not_found') {
        return res.json({ sent: false, url, error: `@${username} ещё не запускал(а) бота — отправьте ссылку вручную` });
      }
      let sent = false;
      if (onFamilyInvite) {
        try {
          sent = (await onFamilyInvite(req.user, resolved.target, token)) === true;
        } catch (err) {
          console.error('[server] family/invite bot msg:', err.message ?? err);
        }
      }
      res.json(
        sent
          ? { sent: true }
          : { sent: false, url, error: 'Не удалось отправить сообщение (бот заблокирован?) — перешлите ссылку вручную' }
      );
    } catch (err) {
      console.error('[server] family/invite:', err.message ?? err);
      res.status(500).json({ error: 'internal' });
    }
  });

  // Ошибки из finance.js/deals.js: «... не найден» → 404, валидация → 400, остальное → 500
  const financeEditError = (res, err, where) => {
    console.error(`[server] finance ${where}:`, err.message ?? err);
    const msg = err instanceof Error ? err.message : '';
    if (/не найден/.test(msg)) return res.status(404).json({ error: msg });
    if (/долж|Неизвестн|пустым|Нет курса|назначить|различа|Недостаточно|Переводы|сделк|Порог/.test(msg)) {
      return res.status(400).json({ error: msg });
    }
    res.status(500).json({ error: 'internal' });
  };

  app.post('/api/finance/accounts', requireAuth, async (req, res) => {
    try {
      const name = String(req.body?.name ?? '').trim().slice(0, 50);
      const currency = String(req.body?.currency ?? '').toUpperCase();
      const startAmount = Number(req.body?.startAmount ?? 0);
      if (!name) return res.status(400).json({ error: 'Укажите имя счёта' });
      if (!CURRENCIES.includes(currency)) {
        return res.status(400).json({ error: `Валюта должна быть одной из: ${CURRENCIES.join(', ')}` });
      }
      if (!Number.isFinite(startAmount) || startAmount < 0) {
        return res.status(400).json({ error: 'Стартовая сумма должна быть числом ≥ 0' });
      }
      const account = await createAccount(req.user.id, name, currency, startAmount, Boolean(req.body?.isSavings));
      res.json({ ok: true, account });
    } catch (err) {
      financeEditError(res, err, 'accounts POST');
    }
  });

  app.patch('/api/finance/accounts/:id', requireAuth, async (req, res) => {
    try {
      // назначить СВОЙ счёт основным (снимает флаг с остальных своих счетов)
      if (req.body?.setDefault === true) {
        await setDefaultAccount(req.user.id, req.params.id);
        return res.json({ ok: true });
      }
      const patch = {};
      if (req.body?.name !== undefined) patch.name = req.body.name;
      if (req.body?.balance !== undefined) patch.balance = req.body.balance;
      if (req.body?.isSavings !== undefined) patch.isSavings = req.body.isSavings;
      const ids = await memberIds(req.user.id);
      // смена валюты: конвертирует баланс и историю операций; баланса из формы ложится поверх конвертации
      if (req.body?.currency !== undefined) {
        await changeAccountCurrency(ids, req.params.id, String(req.body.currency).toUpperCase());
      }
      const account = await updateAccountFields(ids, req.params.id, patch);
      res.json({ ok: true, account });
    } catch (err) {
      financeEditError(res, err, 'accounts PATCH');
    }
  });

  app.delete('/api/finance/accounts/:id', requireAuth, async (req, res) => {
    try {
      await deleteAccountById(await memberIds(req.user.id), req.params.id);
      res.json({ ok: true });
    } catch (err) {
      financeEditError(res, err, 'accounts DELETE');
    }
  });

  app.post('/api/finance/transactions', requireAuth, async (req, res) => {
    try {
      const accountId = String(req.body?.accountId ?? '');
      const kind = req.body?.kind === 'income' ? 'income' : req.body?.kind === 'expense' ? 'expense' : null;
      const amount = Number(req.body?.amount);
      const currency = req.body?.currency ? String(req.body.currency).toUpperCase() : null;
      const description = String(req.body?.description ?? '').trim().slice(0, 200) || null;
      if (!kind) return res.status(400).json({ error: 'Тип операции: expense или income' });
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Сумма должна быть числом > 0' });
      if (currency && !CURRENCIES.includes(currency)) return res.status(400).json({ error: `Неизвестная валюта ${currency}` });
      const result = await applyTransaction({ userId: req.user.id, ids: await memberIds(req.user.id), accountId, kind, amount, currency, description, excluded: req.body?.excluded === true });
      res.json({
        ok: true,
        transaction: { ...result.transaction, id: Number(result.transaction.id) },
        account: result.account,
      });
    } catch (err) {
      financeEditError(res, err, 'transactions POST');
    }
  });

  // Перевод между счетами (в т.ч. другому члену семьи): конвертация через USD
  app.post('/api/finance/transfer', requireAuth, async (req, res) => {
    try {
      const fromAccountId = String(req.body?.fromAccountId ?? '');
      const toAccountId = String(req.body?.toAccountId ?? '');
      const amount = Number(req.body?.amount);
      const toAmount = req.body?.toAmount === '' || req.body?.toAmount == null ? null : Number(req.body.toAmount);
      const currency = req.body?.currency ? String(req.body.currency).toUpperCase() : null;
      const description = String(req.body?.description ?? '').trim().slice(0, 200) || null;
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Сумма должна быть числом > 0' });
      if (toAmount != null && (!Number.isFinite(toAmount) || toAmount <= 0)) {
        return res.status(400).json({ error: 'Сумма зачисления должна быть числом > 0' });
      }
      if (currency && !CURRENCIES.includes(currency)) return res.status(400).json({ error: `Неизвестная валюта ${currency}` });
      const result = await applyTransfer({
        userId: req.user.id,
        ids: await memberIds(req.user.id),
        fromAccountId,
        toAccountId,
        amount,
        currency,
        description,
        toAmount,
      });
      res.json({ ok: true, from: result.from, to: result.to });
    } catch (err) {
      financeEditError(res, err, 'transfer POST');
    }
  });

  // --- Сделки-позиции: покупка крипты со счёта, P&L, пороги уведомлений ---

  // Покупка: списание со счёта + позиция (qty монет symbol за amount в валюте счёта)
  app.post('/api/finance/deals', requireAuth, async (req, res) => {
    try {
      const fromAccountId = String(req.body?.fromAccountId ?? '');
      const symbol = String(req.body?.symbol ?? '').toUpperCase();
      const amount = Number(req.body?.amount);
      const qty = Number(req.body?.qty);
      if (!DEAL_SYMBOLS.includes(symbol)) {
        return res.status(400).json({ error: `Сделки доступны только с криптой: ${DEAL_SYMBOLS.join(', ')}` });
      }
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Сумма должна быть числом > 0' });
      if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Количество монет должно быть числом > 0' });
      const result = await applyDealBuy({
        userId: req.user.id,
        ids: await memberIds(req.user.id),
        fromAccountId,
        symbol,
        amount,
        qty,
        alertUp: req.body?.alertUp === '' || req.body?.alertUp == null ? null : Number(req.body.alertUp),
        alertDown: req.body?.alertDown === '' || req.body?.alertDown == null ? null : Number(req.body.alertDown),
        note: String(req.body?.note ?? '').trim().slice(0, 200) || null,
      });
      res.json({ ok: true, deal: result.deal, account: result.account });
    } catch (err) {
      financeEditError(res, err, 'deals POST');
    }
  });

  // Пороги уведомлений и заметка (смена порога сбрасывает его «уже отправлено»)
  app.patch('/api/finance/deals/:id', requireAuth, async (req, res) => {
    try {
      const patch = {};
      if (req.body?.alertUp !== undefined) patch.alertUp = req.body.alertUp;
      if (req.body?.alertDown !== undefined) patch.alertDown = req.body.alertDown;
      if (req.body?.note !== undefined) patch.note = req.body.note;
      const deal = await updateDealById(await memberIds(req.user.id), req.params.id, patch);
      res.json({ ok: true, deal });
    } catch (err) {
      financeEditError(res, err, 'deals PATCH');
    }
  });

  // Закрытие (продажа): зачисление на счёт; amount — факт в валюте счёта (пусто = рынок)
  app.post('/api/finance/deals/:id/close', requireAuth, async (req, res) => {
    try {
      const toAccountId = String(req.body?.toAccountId ?? '');
      const amount = req.body?.amount === '' || req.body?.amount == null ? null : Number(req.body.amount);
      if (amount != null && (!Number.isFinite(amount) || amount <= 0)) {
        return res.status(400).json({ error: 'Сумма зачисления должна быть числом > 0' });
      }
      const result = await closeDeal({ userId: req.user.id, ids: await memberIds(req.user.id), dealId: req.params.id, toAccountId, amount });
      res.json({ ok: true, deal: result.deal, account: result.account });
    } catch (err) {
      financeEditError(res, err, 'deals close');
    }
  });

  // Удаление сделки вместе со строками операций (балансы откатываются)
  app.delete('/api/finance/deals/:id', requireAuth, async (req, res) => {
    try {
      await deleteDealById(await memberIds(req.user.id), req.params.id);
      res.json({ ok: true });
    } catch (err) {
      financeEditError(res, err, 'deals DELETE');
    }
  });

  app.patch('/api/finance/transactions/:id', requireAuth, async (req, res) => {
    try {
      const patch = {};
      if (req.body?.kind !== undefined) {
        patch.kind = req.body.kind === 'income' ? 'income' : req.body.kind === 'expense' ? 'expense' : null;
      }
      if (req.body?.amount !== undefined) patch.amount = req.body.amount;
      if (req.body?.currency !== undefined) patch.currency = String(req.body.currency).toUpperCase();
      if (req.body?.description !== undefined) patch.description = String(req.body.description).trim().slice(0, 200);
      if (req.body?.excluded !== undefined) patch.excluded = req.body.excluded === true;
      const tx = await updateTransactionById(await memberIds(req.user.id), BigInt(req.params.id), patch);
      res.json({ ok: true, transaction: { ...tx, id: Number(tx.id) } });
    } catch (err) {
      financeEditError(res, err, 'transactions PATCH');
    }
  });

  app.delete('/api/finance/transactions/:id', requireAuth, async (req, res) => {
    try {
      await deleteTransactionById(await memberIds(req.user.id), BigInt(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      financeEditError(res, err, 'transactions DELETE');
    }
  });

  // Ретроспектива RUI/R, посчитанная из дневных цен (не из снапшотов).
  // set=fiat — то же для корзины USD/RUB/THB (свои диапазоны).
  app.get('/api/history', requireAuth, async (req, res) => {    try {
      const window = WINDOWS[req.query.window] ? req.query.window : DEFAULT_WINDOW;
      const fiat = isFiatSet(req);
      const rangeMap = fiat ? FIAT_RANGE_DAYS : HISTORY_RANGE_DAYS;
      const rangeDays = rangeMap[req.query.range] === undefined ? rangeMap['1y'] : rangeMap[req.query.range];
      const metric = req.query.metric === 'r' || req.query.metric === 'rui' ? req.query.metric : null;
      res.json(await getHistorySeries(window, rangeDays, metric, fiat ? FIAT : undefined));
    } catch (err) {
      console.error('[server] history:', err.message ?? err);
      res.status(500).json({ error: 'internal' });
    }
  });

  // Ряды дневных цен (режим «Цена»; set=fiat — курсы USD за единицу)
  app.get('/api/prices', requireAuth, async (req, res) => {
    try {
      const fiat = isFiatSet(req);
      const rangeMap = fiat ? FIAT_RANGE_DAYS : HISTORY_RANGE_DAYS;
      const rangeDays = rangeMap[req.query.range] === undefined ? rangeMap['1y'] : rangeMap[req.query.range];
      res.json(await getPriceSeries(rangeDays, fiat ? FIAT : undefined));
    } catch (err) {
      console.error('[server] prices:', err.message ?? err);
      res.status(500).json({ error: 'internal' });
    }
  });

  // --- Страницы и статика ---

  app.get('/vendor/echarts.min.js', (req, res) => res.sendFile(ECHARTS_PATH));

  // Главная: гостям — публичный лендинг о сервисе, вошедшим — сразу дашборд
  app.get('/', async (req, res) => {
    if (req.user) return res.type('html').send(await page('dashboard.html'));
    const html = (await page('landing.html')).replaceAll('%BOT_USERNAME%', botUsername);
    res.type('html').send(html);
  });

  app.use((req, res) => res.status(404).send('Not found'));

  return app;
}
