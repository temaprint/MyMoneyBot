import { Bot } from 'grammy';
import cron from 'node-cron';
import {
  BOT_TOKEN,
  DAILY_POST_TIME,
  TIMEZONE,
  DEFAULT_WINDOW,
  WINDOWS,
  WINDOW_ALIASES,
  LISTEN_PORT,
  SNAPSHOT_INTERVAL_MIN,
  APP_URL,
  validateConfig,
} from './config.js';
import { getBasketReturns } from './rates.js';
import { formatRuiReport } from './report.js';
import { loadChatIds, subscribe, unsubscribe } from './storage.js';
import { createServer } from './server.js';
import { collectSnapshots } from './snapshots.js';
import { backfillFiatHistory } from './backfill-fiat.js';
import { getUsdRates } from './usrates.js';
import { checkDealAlerts, listDeals } from './deals.js';
import {
  parseAmountLine,
  normalizeCurrency,
  ensureFinanceUser,
  memberIds,
  householdMembers,
  createFamilyInvite,
  joinFamilyByToken,
  resolveInviteTarget,
  listAccounts,
  createAccount,
  deleteAccount,
  setDefaultAccount,
  applyTransaction,
  financeSummary,
  setPendingChoice,
  takePendingChoice,
} from './finance.js';
import { prisma } from './db.js';

const HELP_TEXT = [
  '📈 Индекс относительной недооцененности (RUI) — оценивает каждую монету корзины (TRX, BNB, TON, BTC, ETH, LTC) относительно средней доходности группы M:',
  '',
  'RUI > 0 — монета отстала от корзины (недооценена, кандидат на догоняющий рост)',
  'RUI = 0 — движется в среднем темпе группы',
  'RUI < 0 — опережает корзину (локально перегрета)',
  '',
  'Индексы:',
  '/rui [окно] — индекс по корзине монет. Окна: 24h, 7d, 30d, 365d (или 24ч, 7д, 30д, 365д). Без аргумента — 30д',
  '/subscribe — ежедневный автопост RUI в этот чат · /unsubscribe — отключить',
  '',
  'Личные финансы:',
  '/finance — сводка «богатею или беднею», счета и динамика 7д/30д',
  'Траты и поступления — просто напишите боту в личку:',
  '150 кофе · +50000 зарплата · 12.5 usd кофе · 0.01 btc · 1,5к продукты',
  'Без валюты — списание с вашего основного счёта (⭐) в его валюте, с валютой — любой счёт семьи',
  '/finance add <имя> <валюта> [стартовая сумма] [накоп] — создать счёт. Валюты: usd rub thb trx bnb ton btc eth ltc',
  '/finance del <имя> — удалить счёт',
  'Слово «накоп» в конце — накопительный счёт (сбережения, отдельный блок)',
  '/spend 150 кофе · /income +50000 зарплата — явные команды',
  '',
  'Сделки:',
  '/deals — позиции: купил крипту со счёта, рост/падение и пороги уведомлений',
  'Покупка/закрытие и пороги (напр. +5% / −5%) — на дашборде, раздел «Сделки»; уведомление приходит сюда один раз на порог',
  '',
  'Семья:',
  '/family @username — пригласить близкого: общие счета, траты и график богатства',
  '',
  `Веб-дашборд: ${APP_URL}`,
  '/startweb — вход без пароля, одноразовая ссылка на 5 минут',
  'Внутри: графики RUI/R/цен по корзине монет и фиату (USD, RUB, THB, KRW) с историей до 5 лет, редактор финансов и переводов, калькулятор обмена крипты и фиата, ИИ-аналитика периода с веб-поиском и архив отчётов',
  '',
  'Кнопки под полем ввода: Финансы · RUI · Дашборд · Помощь',
].join('\n');

// Короткое приветствие /start: суть сервиса + быстрый старт, полная справка — /help
const WELCOME_TEXT = [
  '👋 Привет! Это RUI — сервис, который находит недооценённые крипту и фиат и ведёт семейные финансы.',
  '',
  'Быстрый старт:',
  '📊 RUI — индекс по корзине монет (или /rui 7д, 30д, 365д)',
  '💰 Финансы — сводка и счета; траты пишите сразу: «150 кофе», «+50000 зарплата»',
  '🌐 Дашборд — графики с историей до 5 лет, ИИ-аналитика, калькулятор обмена',
  '❓ Помощь — все команды и форматы',
  '',
  `Подробнее о сервисе: ${APP_URL}`,
].join('\n');

// --- Главная reply-клавиатура (навигация в личке) ---

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '💰 Финансы' }, { text: '📊 RUI' }],
    [{ text: '🌐 Дашборд' }, { text: '❓ Помощь' }],
  ],
  resize_keyboard: true,
};

function replyWithMenu(ctx, text) {
  const extra = ctx.chat?.type === 'private' ? { reply_markup: MAIN_KEYBOARD } : {};
  return ctx.reply(text, extra);
}

function normalizeWindow(arg) {
  const key = arg.trim().toLowerCase();
  if (!key) return DEFAULT_WINDOW;
  return WINDOWS[key] ? key : WINDOW_ALIASES[key] ?? null;
}

async function buildReport(windowLabel, weeklyResult = null) {
  const result = await getBasketReturns(windowLabel);
  return formatRuiReport(result, windowLabel, weeklyResult);
}

// --- Личные финансы ---

function fmtUsd(v) {
  if (v == null) return '—';
  const abs = Math.abs(v);
  const s = abs >= 1000 ? Math.round(abs).toLocaleString('en-US') : abs.toFixed(2);
  return (v < 0 ? '−$' : '$') + s;
}

function fmtAmount(v) {
  const abs = Math.abs(v);
  const s =
    abs >= 1000 ? Math.round(abs).toLocaleString('en-US')
    : abs >= 1 ? String(Number(v.toFixed(2)))
    : String(Number(v.toFixed(6)));
  return (v < 0 ? '−' : '') + s;
}

function trendLine(d) {
  if (!d) return '—';
  const pct = (d.pct >= 0 ? '+' : '') + d.pct.toFixed(1) + '%';
  return `${fmtUsd(d.usd)} (${pct})`;
}

// 1 трата / 2 траты / 5 трат
function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function transactionText({ transaction, account }) {
  const sign = transaction.kind === 'income' ? '+' : '−';
  const usdPart = transaction.currency === 'USD' ? '' : ` (≈ ${fmtUsd(transaction.usd)})`;
  const desc = transaction.description ? `${transaction.description}: ` : '';
  return (
    `${desc}${sign}${fmtAmount(transaction.amount)} ${transaction.currency}${usdPart}` +
    ` · счёт «${account.name}» · остаток ${fmtAmount(account.balance)} ${account.currency}`
  );
}

async function financeText(userId) {
  const [ids, members] = await Promise.all([memberIds(userId), householdMembers(userId)]);
  const s = await financeSummary(ids);
  const current = s.accounts.filter((a) => !a.isSavings);
  const savings = s.accounts.filter((a) => a.isSavings);
  const line = (a) =>
    `• ${a.name} (${a.currency}): ${fmtAmount(a.balance)}${a.isDefault ? ' ⭐' : ''}` +
    (a.currency !== 'USD' && a.usd != null ? ` ≈ ${fmtUsd(a.usd)}` : '') +
    (a.userId !== userId && a.ownerName ? ` · ${a.ownerName}` : '');
  const lines = [
    `💰 Всего: ${fmtUsd(s.total.usd)}`,
    `7д: ${trendLine(s.total.d7)} · 30д: ${trendLine(s.total.d30)} — ${s.total.verdict}`,
    `💸 Текущие: ${fmtUsd(s.current.usd)}`,
    `7д: ${trendLine(s.current.d7)} · 30д: ${trendLine(s.current.d30)}`,
    '',
    'Счета:',
    ...current.map(line),
  ];
  if (savings.length) {
    lines.push(
      '',
      `🐷 Накопления: ${fmtUsd(s.savings.usd)}`,
      `7д: ${trendLine(s.savings.d7)} · 30д: ${trendLine(s.savings.d30)} — ${s.savings.verdict}`,
      ...savings.map(line)
    );
  }
  if (s.deals?.costUsd > 0) {
    const pct = s.deals.pnlPct == null ? '—' : (s.deals.pnlPct >= 0 ? '+' : '') + s.deals.pnlPct.toFixed(1) + '%';
    lines.push('', `💼 Сделки: ${fmtUsd(s.deals.usd)} · к покупке ${pct} · /deals`);
  }
  if (members.length > 1) {
    lines.push('', `👨‍👩‍👧 Семья: ${members.map((m) => m.firstName || m.username || '—').join(', ')}`);
  } else {
    lines.push('', '👨‍👩‍👧 Семейный доступ — пригласить близких: /family');
  }
  lines.push('', '/finance add <имя> <валюта> [сумма] [накоп] · /finance del <имя>');
  // основным можно назначить только свой счёт
  const keyboard = current
    .filter((a) => a.userId === userId && !a.isDefault)
    .map((a) => [{ text: `⭐ «${a.name}» — сделать основным`, callback_data: `fd:${a.id}` }]);
  const extra = keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
  return { text: lines.join('\n'), extra };
}

// Запись траты/поступления: 0 счетов — подсказка; без валюты — СВОЙ основной счёт (⭐) в его валюте;
// с валютой — единственный счёт семьи в ней или свой основной с конвертацией; несколько — выбор кнопкой
async function handleAmountInput(ctx, parsed) {
  const user = await ensureFinanceUser(ctx.from);
  const ids = await memberIds(user.id);
  const accounts = await listAccounts(ids);
  if (accounts.length === 0) {
    return ctx.reply('Сначала создайте счёт: /finance add Наличные thb 3000');
  }
  const data = {
    kind: parsed.kind,
    amount: parsed.amount,
    currency: parsed.currency,
    description: parsed.description,
  };
  // свой основной (⭐), иначе свой первый, иначе основной семьи, иначе любой
  const own = accounts.filter((a) => a.userId === user.id);
  const defaultAccount =
    own.find((a) => a.isDefault) ?? own[0] ?? accounts.find((a) => a.isDefault) ?? accounts[0];
  const candidates = parsed.currency ? accounts.filter((a) => a.currency === parsed.currency) : [defaultAccount];
  const target = candidates.length === 1 ? candidates[0] : candidates.length === 0 ? defaultAccount : null;

  if (target) {
    const result = await applyTransaction({ userId: user.id, ids, accountId: target.id, ...data });
    return ctx.reply(`✓ ${transactionText(result)}`);
  }
  setPendingChoice(ctx.from.id, { userId: user.id, ...data, accountIds: candidates.map((a) => a.id) });
  await ctx.reply('На какой счёт?', {
    reply_markup: {
      inline_keyboard: candidates.map((a, i) => [
        {
          text: `${a.name}${a.userId !== user.id && a.ownerName ? ` (${a.ownerName})` : ''} · ${fmtAmount(a.balance)} ${a.currency}`,
          callback_data: `fa:${i}`,
        },
      ]),
    },
  });
}

async function handleFinanceCommand(ctx) {
  const user = await ensureFinanceUser(ctx.from);
  const arg = (ctx.match ?? '').trim();

  // /finance add [<имя из нескольких слов>] <валюта> [стартовая сумма] [накоп]
  if (arg.startsWith('add')) {
    const parts = arg.split(/\s+/).slice(1).filter(Boolean);
    let startAmount = 0;
    const last = parts[parts.length - 1];
    if (last && /^\d+(?:[.,]\d+)?$/.test(last)) {
      startAmount = Number(last.replace(',', '.'));
      parts.pop();
    }
    let currency = 'USD';
    const guess = normalizeCurrency(parts[parts.length - 1] ?? '');
    if (guess) {
      currency = guess;
      parts.pop();
    }
    let isSavings = false;
    if (parts.length && /^(накоп|накопления|накопительный|сбер|сбережения|savings)$/i.test(parts[parts.length - 1])) {
      isSavings = true;
      parts.pop();
    }
    const name = parts.join(' ').trim();
    if (!name) {
      return ctx.reply('Формат: /finance add <имя> <валюта> [стартовая сумма] [накоп] — например, /finance add Наличные thb 3000');
    }
    await createAccount(user.id, name, currency, startAmount, isSavings);
    const { text, extra } = await financeText(user.id);
    return ctx.reply(`✓ Счёт «${name}» (${currency}${isSavings ? ', накопительный' : ''}) создан\n\n${text}`, extra);
  }

  // /finance del <имя>
  if (arg.startsWith('del')) {
    const name = arg.slice(3).trim();
    if (!name) return ctx.reply('Формат: /finance del <имя>');
    const result = await deleteAccount(user.id, name);
    if (result.count === 0) return ctx.reply(`Счёт «${name}» не найден`);
    return ctx.reply(`✓ Счёт «${name}» удалён (вместе с его историей)`);
  }

  if (arg) {
    return ctx.reply('Не понял. Доступно: /finance · /finance add <имя> <валюта> [сумма] · /finance del <имя>');
  }

  let accounts = await listAccounts(user.id);
  if (accounts.length === 0) {
    await createAccount(user.id, 'Основной', 'USD', 0);
    await ctx.reply('Создал счёт «Основной» (USD, баланс 0). Стартовую сумму можно задать через /finance add или тратами: +50000 зарплата');
  }
  const { text, extra } = await financeText(user.id);
  return ctx.reply(text, extra);
}

async function handleSpendIncome(ctx, forceKind) {
  const parsed = parseAmountLine(ctx.match ?? '');
  if (!parsed) {
    return ctx.reply('Формат: /spend 150 кофе или /income +50000 зарплата (сумма первой)');
  }
  parsed.kind = forceKind;
  try {
    await handleAmountInput(ctx, parsed);
  } catch (err) {
    console.error('finance:', err.message ?? err);
    await ctx.reply(`Не удалось записать: ${err.message ?? 'ошибка'}`);
  }
}

// Действия кнопок главной клавиатуры
const BUTTON_ACTIONS = {
  '💰 Финансы': (ctx) => handleFinanceCommand(ctx),
  '📊 RUI': async (ctx) => {
    await ctx.reply('Считаю...');
    await ctx.reply(await buildReport(DEFAULT_WINDOW));
  },
  '🌐 Дашборд': (ctx) => handleWebLogin(ctx),
  '❓ Помощь': (ctx) => replyWithMenu(ctx, HELP_TEXT),
};

// Блок личных финансов для автопоста: что добавили за последние сутки.
// Только личные чаты (chatId = telegramId пользователя); в группах финансы приватны.
async function dailyFinanceBlock(chatId) {
  if (Number(chatId) <= 0) return null;
  const user = await prisma.user.findUnique({ where: { telegramId: String(chatId) } });
  if (!user) return null;
  const ids = await memberIds(user.id);
  const hasAccounts = await prisma.account.count({ where: { userId: { in: ids } } });
  if (!hasAccounts) return null; // финансы не ведутся — не напоминаем

  const txs = await prisma.transaction.findMany({
    where: {
      userId: { in: ids },
      kind: { in: ['expense', 'income'] },
      createdAt: { gte: new Date(Date.now() - 86400e3) },
    },
    select: { kind: true, usd: true },
  });
  const expenses = txs.filter((t) => t.kind === 'expense');
  const incomes = txs.filter((t) => t.kind === 'income');
  if (expenses.length + incomes.length === 0) {
    return (
      '💰 Финансы за сутки: ничего не записано\n' +
      'Похоже, траты за день не добавлены — напишите боту, например: «150 кофе» или /spend 150 кофе'
    );
  }
  const sumUsd = (arr) => arr.reduce((s, t) => s + t.usd, 0);
  const parts = [];
  if (expenses.length) {
    parts.push(`${pluralRu(expenses.length, 'трата', 'траты', 'трат')} — ${expenses.length} на −${fmtUsd(sumUsd(expenses))}`);
  }
  if (incomes.length) {
    parts.push(`${pluralRu(incomes.length, 'поступление', 'поступления', 'поступлений')} — ${incomes.length} на +${fmtUsd(sumUsd(incomes))}`);
  }
  return `💰 Финансы за сутки: ${parts.join(' · ')}`;
}

async function sendDailyReports(bot) {
  try {
    const chatIds = await loadChatIds();
    if (chatIds.length === 0) return;

    // Недельная тенденция — из того же кэша корзины, без доп. запросов к API
    let weeklyResult = null;
    if (DEFAULT_WINDOW !== '7d') {
      try {
        weeklyResult = await getBasketReturns('7d');
      } catch {
        // не удалось — рассылаем без недельной колонки
      }
    }
    const text = await buildReport(DEFAULT_WINDOW, weeklyResult);

    for (const chatId of chatIds) {
      try {
        const financeBlock = await dailyFinanceBlock(chatId);
        await bot.api.sendMessage(chatId, financeBlock ? `${text}\n\n${financeBlock}` : text);
      } catch (err) {
        if (err.error_code === 403) {
          await unsubscribe(chatId).catch(() => {}); // бот заблокирован пользователем
          console.log(`Чат ${chatId} отписан (403)`);
        } else {
          console.error(`Не доставлено в ${chatId}:`, err.message ?? err);
        }
      }
    }
  } catch (err) {
    console.error('Ежедневный отчёт не собран:', err.message ?? err);
  }
}

// Deep-link вход в дашборд: бот просит у своего же API одноразовый токен
async function handleWebLogin(ctx) {
  try {
    const res = await fetch(`http://127.0.0.1:${LISTEN_PORT}/api/auth/bot-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: BOT_TOKEN,
        id: ctx.from.id,
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.loginUrl) throw new Error(data.error ?? `HTTP ${res.status}`);
    await ctx.reply('Вход в дашборд RUI (ссылка действует 5 минут):', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Открыть дашборд', url: data.loginUrl }]],
      },
    });
  } catch (err) {
    console.error('web-login:', err.message ?? err);
    await ctx.reply('Не удалось создать ссылку входа. Попробуйте позже.');
  }
}

// Приглашение в личку адресату: сообщение с кнопкой подтверждения
async function sendFamilyInvite(bot, inviterFrom, target, token) {
  const inviterName = inviterFrom.first_name || inviterFrom.username || 'Пользователь';
  await bot.api.sendMessage(
    target.telegramId,
    `👨‍👩‍👧 ${inviterName} приглашает вас в семью!\n\n` +
      'Члены семьи видят все счета и операции друг друга и могут добавлять свои. ' +
      'Приглашение одноразовое, действует 24 часа.',
    { reply_markup: { inline_keyboard: [[{ text: '✓ Присоединиться к семье', callback_data: `fj:${token}` }]] } }
  );
}

// Семья: /family — статус, /family @username — отправить приглашение в личку
async function handleFamilyCommand(ctx, bot, botUsername) {
  const user = await ensureFinanceUser(ctx.from);
  const members = await householdMembers(user.id);
  const names = members.map((m) => m.firstName || m.username || '—').join(', ');
  const status =
    members.length > 1
      ? `👨‍👩‍👧 В семье: ${names}\n\nВсе участники видят и правят общие счета и операции.`
      : '👨‍👩‍👧 Семейный доступ: близкие будут видеть все счета и операции, добавлять свои траты.';

  const arg = (ctx.match ?? '').trim();
  if (!arg) {
    return ctx.reply(`${status}\n\nПригласить: /family @username — бот пришлёт приглашение в личку.`);
  }

  const username = arg.replace(/^@/, '').replace(/\s+.*$/, ''); // только первое слово
  const resolved = await resolveInviteTarget(user.id, username);
  if (resolved.reason === 'invalid') return ctx.reply('Формат: /family @username (латиница, цифры и _)');
  if (resolved.reason === 'already') return ctx.reply(`@${username} уже в вашей семье 👨‍👩‍👧`);
  if (resolved.reason === 'other') return ctx.reply(`@${username} уже состоит в другой семье`);

  const token = await createFamilyInvite(user.id);
  const linkButton = { text: '🔗 Ссылка-приглашение (24ч)', url: `https://t.me/${botUsername}?start=fam_${token}` };
  if (resolved.reason === 'not_found') {
    return ctx.reply(
      `@${username} ещё не запускал(а) бота — написать первым бот не может.\nОтправьте ссылку вручную:`,
      { reply_markup: { inline_keyboard: [[linkButton]] } }
    );
  }
  try {
    await sendFamilyInvite(bot, ctx.from, resolved.target, token);
    return ctx.reply(`✓ Приглашение отправлено @${username}`);
  } catch (err) {
    console.error('family invite send:', err.message ?? err);
    return ctx.reply(`Не удалось написать @${username} (возможно, бот заблокирован). Отправьте ссылку вручную:`, {
      reply_markup: { inline_keyboard: [[linkButton]] },
    });
  }
}

// Deep-link t.me/<bot>?start=fam_<token>: подтверждение перед вступлением
async function handleFamilyJoin(ctx, token) {
  await ctx.reply(
    '👨‍👩‍👧 Вас пригласили в семью!\n\n' +
      'Члены семьи видят все счета и операции друг друга и могут добавлять свои. ' +
      'Приглашение одноразовое, действует 24 часа.',
    { reply_markup: { inline_keyboard: [[{ text: '✓ Присоединиться к семье', callback_data: `fj:${token}` }]] } }
  );
}

async function main() {
  const errors = validateConfig();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }

  const bot = new Bot(BOT_TOKEN);
  bot.catch((err) => console.error('Ошибка обработчика:', err));

  // Заблокированные (раздел «Админ»): молча игнорируем их апдейты.
  // Заодно фиксируем активность (lastSeenAt) — не чаще раза в минуту, с кэшем статуса.
  const userState = new Map(); // telegramId -> { blocked, lastSeen, fetchedAt }
  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const tid = String(ctx.from.id);
    let st = userState.get(tid);
    if (!st || Date.now() - st.fetchedAt > 60_000) {
      const u = await prisma.user.findUnique({ where: { telegramId: tid }, select: { isBlocked: true, lastSeenAt: true } });
      st = { blocked: Boolean(u?.isBlocked), lastSeen: u?.lastSeenAt?.getTime() ?? 0, fetchedAt: Date.now() };
      userState.set(tid, st);
    }
    if (st.blocked) return; // без ответа — как будто бота нет
    if (Date.now() - st.lastSeen > 60_000) {
      st.lastSeen = Date.now();
      prisma.user.updateMany({ where: { telegramId: tid }, data: { lastSeenAt: new Date() } }).catch(() => {});
    }
    return next();
  });

  const me = await bot.api.getMe();
  console.log(`Бот @${me.username} запущен`);

  // Автоподсказки команд в Telegram
  await bot.api
    .setMyCommands([
      { command: 'rui', description: 'Индекс недооцененности монет (24h, 7d, 30d, 365d)' },
      { command: 'finance', description: 'Финансы: сводка, счета, траты' },
      { command: 'deals', description: 'Сделки: позиции крипты и P&L' },
      { command: 'family', description: 'Семья: пригласить близких' },
      { command: 'startweb', description: 'Вход в веб-дашборд' },
      { command: 'subscribe', description: 'Ежедневный автопост RUI' },
      { command: 'unsubscribe', description: 'Отключить автопост' },
      { command: 'spend', description: 'Записать трату: /spend 150 кофе' },
      { command: 'income', description: 'Записать поступление: /income +50000 зарплата' },
      { command: 'help', description: 'Справка' },
    ])
    .catch((err) => console.error('setMyCommands:', err.message));

  const app = createServer({
    botUsername: me.username,
    // веб-кнопка «Пригласить»: бот доставляет приглашение адресату в личку
    onFamilyInvite: async (inviter, target, token) => {
      try {
        await sendFamilyInvite(bot, { first_name: inviter.firstName, username: inviter.username }, target, token);
        return true;
      } catch (err) {
        console.error('family invite msg:', err.message ?? err);
        return false;
      }
    },
  });
  const server = app.listen(LISTEN_PORT, () => {
    console.log(`Веб-сервер: http://127.0.0.1:${LISTEN_PORT}`);
  });

  bot.command('start', async (ctx) => {
    // deep-link t.me/bot?start=startweb приходит как /start c payload
    if (ctx.payload === 'startweb') return handleWebLogin(ctx);
    if (ctx.payload?.startsWith('fam_')) return handleFamilyJoin(ctx, ctx.payload.slice(4));
    return replyWithMenu(ctx, WELCOME_TEXT);
  });
  bot.command('startweb', (ctx) => handleWebLogin(ctx));
  bot.command('help', (ctx) => replyWithMenu(ctx, HELP_TEXT));

  bot.command('rui', async (ctx) => {
    const label = normalizeWindow(ctx.match ?? '');
    if (!label) {
      return ctx.reply(`Неизвестное окно "${ctx.match}". Допустимо: 24h, 7d, 30d, 365d`);
    }
    await ctx.reply('Считаю...');
    try {
      await ctx.reply(await buildReport(label));
    } catch (err) {
      console.error('Расчёт RUI не удался:', err.message ?? err);
      await ctx.reply(`Не удалось рассчитать RUI: ${err.message ?? 'неизвестная ошибка'}`);
    }
  });

  bot.command('subscribe', async (ctx) => {
    try {
      const added = await subscribe(ctx.chat.id);
      return ctx.reply(
        added
          ? `Готово: ежедневный отчёт RUI (окно ${DEFAULT_WINDOW}) в ${DAILY_POST_TIME} (${TIMEZONE})`
          : 'Этот чат уже подписан'
      );
    } catch (err) {
      console.error('subscribe:', err.message ?? err);
      return ctx.reply('Ошибка базы данных, попробуйте позже');
    }
  });

  bot.command('unsubscribe', async (ctx) => {
    try {
      const removed = await unsubscribe(ctx.chat.id);
      return ctx.reply(removed ? 'Автопост отключён' : 'Этот чат не был подписан');
    } catch (err) {
      console.error('unsubscribe:', err.message ?? err);
      return ctx.reply('Ошибка базы данных, попробуйте позже');
    }
  });

  bot.command('finance', async (ctx) => {
    try {
      await handleFinanceCommand(ctx);
    } catch (err) {
      console.error('finance:', err.message ?? err);
      await ctx.reply('Не удалось получить сводку, попробуйте позже');
    }
  });

  bot.command('family', async (ctx) => {
    try {
      await handleFamilyCommand(ctx, bot, me.username);
    } catch (err) {
      console.error('family:', err.message ?? err);
      await ctx.reply('Не удалось отправить приглашение, попробуйте позже');
    }
  });

  // Сделки-позиции: открытые с текущим P&L и порогами уведомлений
  bot.command('deals', async (ctx) => {
    try {
      const user = await ensureFinanceUser(ctx.from);
      const ids = await memberIds(user.id);
      const rates = await getUsdRates();
      const deals = (await listDeals(ids, rates)).filter((d) => d.status === 'open');
      if (!deals.length) {
        return ctx.reply('Открытых сделок нет. Купить крипту со счёта и поставить пороги — раздел «Сделки» на дашборде.');
      }
      const lines = deals.map((d) => {
        const pct = d.pnlPct == null ? '—' : (d.pnlPct >= 0 ? '+' : '') + d.pnlPct.toFixed(1) + '%';
        const now = d.valueUsd == null ? '—' : fmtUsd(d.valueUsd);
        const alerts = [d.alertUp != null ? `+${d.alertUp}%` : null, d.alertDown != null ? `−${d.alertDown}%` : null]
          .filter(Boolean)
          .join(' / ');
        return `• ${d.symbol}: ${fmtAmount(d.qty)} · вход ${fmtUsd(d.spentUsd)} → ${now} (${pct})${alerts ? ` · 🔔 ${alerts}` : ''}`;
      });
      return ctx.reply(['💼 Открытые сделки:', ...lines].join('\n'));
    } catch (err) {
      console.error('deals:', err.message ?? err);
      await ctx.reply('Не удалось получить сделки, попробуйте позже');
    }
  });

  // Явные алиасы для трат/поступлений (в личке работает и просто «150 кофе»)
  bot.command('spend', (ctx) => handleSpendIncome(ctx, 'expense'));
  bot.command('income', (ctx) => handleSpendIncome(ctx, 'income'));

  // Свободный ввод в личке: кнопки меню, «150 кофе», «+50000 зарплата». Обычный текст игнорируем.
  bot.on('message:text', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    try {
      const buttonAction = BUTTON_ACTIONS[text];
      if (buttonAction) return await buttonAction(ctx);
      const parsed = parseAmountLine(text);
      if (!parsed) return;
      await handleAmountInput(ctx, parsed);
    } catch (err) {
      console.error('message:text:', err.message ?? err);
      await ctx.reply(`Ошибка: ${err.message ?? 'попробуйте позже'}`);
    }
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    try {
      // fa:<i> — выбор счёта для отложенной транзакции
      if (data.startsWith('fa:')) {
        const pending = takePendingChoice(ctx.from.id);
        if (!pending) {
          return ctx.answerCallbackQuery('Время выбора истекло — отправьте сумму ещё раз');
        }
        const accountId = pending.accountIds[Number(data.slice(3))];
        if (!accountId) return ctx.answerCallbackQuery('Счёт не найден');
        const result = await applyTransaction({
          userId: pending.userId,
          ids: await memberIds(pending.userId),
          accountId,
          kind: pending.kind,
          amount: pending.amount,
          currency: pending.currency,
          description: pending.description,
        });
        await ctx.editMessageText(`✓ ${transactionText(result)}`);
        return ctx.answerCallbackQuery();
      }
      // fd:<id> — сделать счёт основным
      if (data.startsWith('fd:')) {
        const user = await ensureFinanceUser(ctx.from);
        await setDefaultAccount(user.id, data.slice(3));
        const { text, extra } = await financeText(user.id);
        await ctx.editMessageText(text, extra).catch(() => ctx.reply(text, extra));
        return ctx.answerCallbackQuery('Основной счёт обновлён');
      }
      // fj:<token> — подтверждённое вступление в семью (кнопка из ссылки или пересланного сообщения)
      if (data.startsWith('fj:')) {
        const user = await ensureFinanceUser(ctx.from);
        const result = await joinFamilyByToken(user.id, data.slice(3));
        if (!result.ok) {
          const msg = {
            expired: 'Ссылка недействительна: истекла или уже использована',
            already: 'Вы уже участник этой семьи',
            other: 'Вы уже в другой семье',
          }[result.error] ?? 'Не удалось присоединиться';
          await ctx.answerCallbackQuery(msg);
          return ctx.editMessageText(msg).catch(() => ctx.reply(msg));
        }
        await ctx.answerCallbackQuery('Добро пожаловать!');
        await ctx
          .editMessageText(
            '👨‍👩‍👧 Добро пожаловать в семью!\n\nТеперь вы видите общие счета, траты и график богатства. ' +
              'Свои траты пишите так же: «150 кофе» — спишется с вашего основного счёта (⭐).'
          )
          .catch(() => {});
        // уведомим остальных членов семьи
        const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { householdId: true } });
        if (fresh?.householdId) {
          const others = await prisma.user.findMany({
            where: { householdId: fresh.householdId, id: { not: user.id } },
            select: { telegramId: true },
          });
          const name = ctx.from.first_name || ctx.from.username || 'Новый участник';
          for (const o of others) {
            await bot.api.sendMessage(o.telegramId, `👨‍👩‍👧 ${name} теперь в вашей семье`).catch(() => {});
          }
        }
        return replyWithMenu(ctx, HELP_TEXT);
      }
      return ctx.answerCallbackQuery();
    } catch (err) {
      console.error('callback:', err.message ?? err);
      await ctx.answerCallbackQuery('Ошибка, попробуйте позже');
    }
  });

  const [hh, mm] = DAILY_POST_TIME.split(':').map(Number);
  const cronExpr = `${mm} ${hh} * * *`;
  if (!cron.validate(cronExpr)) {
    console.error(`Некорректное расписание из DAILY_POST_TIME=${DAILY_POST_TIME}`);
    process.exit(1);
  }
  cron.schedule(cronExpr, () => sendDailyReports(bot), { timezone: TIMEZONE });
  console.log(`Ежедневный автопост: ${DAILY_POST_TIME} (${TIMEZONE}), cron "${cronExpr}"`);

  // история фиата (раздел FIAT): подтягивается сама при первом старте/деплое.
  // Стартовый всплеск запросов CoinGecko даёт 429 — ждём 2 минуты и ретраим до 5 раз.
  const ensureFiatHistory = async (retries = 5) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const days = await backfillFiatHistory();
        if (days) console.log(`[fiat] бэкфилл: ${days} дней`);
        return;
      } catch (err) {
        console.error(`[fiat] бэкфилл (попытка ${attempt}/${retries}):`, err.message ?? err);
        await new Promise((resolve) => setTimeout(resolve, 10 * 60 * 1000));
      }
    }
  };
  setTimeout(() => ensureFiatHistory().catch(() => {}), 2 * 60 * 1000);

  // Один тик: снапшоты (обновляют сегодняшние цены в БД) → проверка порогов сделок.
  // Уведомления идут в Telegram владельцу сделки, одноразово на порог.
  const snapshotTick = async () => {
    await collectSnapshots();
    const sent = await checkDealAlerts((telegramId, text) => bot.api.sendMessage(telegramId, text));
    if (sent) console.log(`[deals] уведомлений отправлено: ${sent}`);
  };
  snapshotTick().catch((err) => console.error('первый тик снапшотов:', err.message ?? err));
  const snapshotTimer = setInterval(
    () => snapshotTick().catch((err) => console.error('тик снапшотов:', err.message ?? err)),
    SNAPSHOT_INTERVAL_MIN * 60 * 1000
  );
  console.log(`Снимки в БД: каждые ${SNAPSHOT_INTERVAL_MIN} мин (+ проверка порогов сделок)`);

  const shutdown = async (signal) => {
    console.log(`${signal}: останавливаюсь`);
    clearInterval(snapshotTimer);
    server.close();
    await bot.stop().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await bot.start(); // long polling
}

main().catch((err) => {
  console.error('Запуск не удался:', err.message ?? err);
  process.exit(1);
});
