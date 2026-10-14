// Бэкфилл дневных курсов фиата (USD, RUB, THB, KRW) для раздела FIAT.
// Запуск: node src/backfill-fiat.js [force]   (docker compose exec app node src/backfill-fiat.js)
// Источники (keyless, без CoinGecko):
//   RUB — официальный курс ЦБ (XML_dynamic.asp, диапазон одним запросом);
//   THB, KRW — референс-курсы ЕЦБ (frankfurter.dev, диапазон одним запросом);
//   USD — 1.
// ЦБ и ЕЦБ публикуют курсы по рабочим дням: выходные/праздники закрываются
// переносом последнего курса (forward-fill), серии получаются непрерывными.
// Сегодняшнюю строку дополнительно актуализирует collectSnapshots (er-api).
// При старте приложения вызывается автоматически (index.js), если истории нет.
import 'dotenv/config';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prisma } from './db.js';
import { FIAT } from './config.js';

const DAYS = 365;
const MS_PER_DAY = 86_400_000;

const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

async function fetchJson(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  return res.json();
}

// frankfurter -> { 'YYYY-MM-DD': { THB, KRW } } — единиц за 1 USD, рабочие дни ЕЦБ
async function fetchFrankfurter(fromStr, toStr) {
  const data = await fetchJson(
    `https://api.frankfurter.dev/v1/${fromStr}..${toStr}?base=USD&symbols=THB,KRW`,
    'frankfurter'
  );
  if (!data.rates || Object.keys(data.rates).length === 0) {
    throw new Error('frankfurter: пустой ответ');
  }
  return data.rates;
}

// ЦБ РФ -> { 'YYYY-MM-DD': rubPerUsd } — рабочие дни ЦБ
async function fetchCbrRub(fromStr, toStr) {
  const [fy, fm, fd] = fromStr.split('-');
  const [ty, tm, td] = toStr.split('-');
  const res = await fetch(
    `https://www.cbr.ru/scripts/XML_dynamic.asp?date_req1=${fd}/${fm}/${fy}&date_req2=${td}/${tm}/${ty}&VAL_NM_RQ=R01235`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; rui-bot/1.0)' } }
  );
  if (!res.ok) throw new Error(`ЦБ РФ HTTP ${res.status}`);
  const xml = await res.text();
  const rates = {};
  for (const m of xml.matchAll(/Date="(\d{2})\.(\d{2})\.(\d{4})"[\s\S]*?<Value>([\d,]+)<\/Value>/g)) {
    rates[`${m[3]}-${m[2]}-${m[1]}`] = Number(m[4].replace(',', '.'));
  }
  if (Object.keys(rates).length === 0) throw new Error('ЦБ РФ: не распознаны курсы в ответе');
  return rates;
}

// Перенос курса на дни без публикации -> непрерывная серия { день: ед. за 1 USD }
function fillDaily(sparse, days) {
  const out = {};
  let last = null;
  for (const day of days) {
    if (typeof sparse[day] === 'number' && sparse[day] > 0) last = sparse[day];
    if (last !== null) out[day] = last;
  }
  return out;
}

const pick = (frank, code) =>
  Object.fromEntries(Object.entries(frank).filter(([, r]) => r[code] > 0).map(([d, r]) => [d, r[code]]));

// Пишет ~365 дневных строк на каждую валюту FIAT (USD за 1 единицу).
// Возвращает число дней. Перезапускаемо: старые строки FIAT заменяются.
export async function backfillFiatHistory(force = false) {
  if (!force) {
    // пропускаем только если история есть у ВСЕХ валют корзины
    // (иначе расширение корзины — напр. добавление KRW — не долилось бы)
    let complete = true;
    for (const symbol of FIAT) {
      const have = await prisma.price.count({ where: { symbol } });
      if (have < DAYS - 2) complete = false;
    }
    if (complete) return 0;
  }

  const days = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = DAYS - 1; i >= 0; i--) days.push(dayStr(today.getTime() - i * MS_PER_DAY));

  const frank = await fetchFrankfurter(days[0], days.at(-1));
  const cbr = await fetchCbrRub(days[0], days.at(-1));
  const series = {
    RUB: fillDaily(cbr, days),
    THB: fillDaily(pick(frank, 'THB'), days),
    KRW: fillDaily(pick(frank, 'KRW'), days),
  };

  const rows = [];
  for (const day of days) {
    // день должен быть во всех сериях (после forward-fill — это лишь хвосты источников)
    if (!Object.values(series).every((s) => typeof s[day] === 'number')) continue;
    const date = new Date(`${day}T00:00:00Z`);
    rows.push({ symbol: 'USD', date, price: 1 });
    for (const symbol of ['RUB', 'THB', 'KRW']) {
      rows.push({ symbol, date, price: 1 / series[symbol][day] });
    }
  }
  if (rows.length === 0) throw new Error('не нашлось общих дней в сериях фиата');
  await prisma.$transaction([
    prisma.price.deleteMany({ where: { symbol: { in: FIAT } } }),
    prisma.price.createMany({ data: rows }),
  ]);
  return rows.length / FIAT.length;
}

const isCli = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isCli) {
  const force = process.argv[2] === 'force';
  backfillFiatHistory(force)
    .then(async (days) => {
      if (days === 0) {
        console.log('История фиата уже есть — пропускаю (force для перезаписи)');
      } else {
        console.log(`[fiat] записано дней: ${days}`);
        for (const symbol of FIAT) {
          const [min, max, cnt] = await Promise.all([
            prisma.price.findFirst({ where: { symbol }, orderBy: { date: 'asc' } }),
            prisma.price.findFirst({ where: { symbol }, orderBy: { date: 'desc' } }),
            prisma.price.count({ where: { symbol } }),
          ]);
          console.log(
            `[итог] ${symbol}: ${cnt} дней (${min?.date.toISOString().slice(0, 10) ?? '-'} .. ${max?.date.toISOString().slice(0, 10) ?? '-'})`
          );
        }
      }
      await prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error('Бэкфилл фиата не удался:', err.message ?? err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
