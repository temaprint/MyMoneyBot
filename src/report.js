import { WINDOW_LABELS_RU } from './config.js';

const PARITY_BAND = 0.05; // |RUI| < 0.05% считаем паритетом
const TREND_BAND = 0.5; // |R 7д| < 0.5% — боковик (≈)

const fmtPct = (x) => (x >= 0 ? '+' : '') + x.toFixed(2) + '%';
const fmtPct1 = (x) => (x >= 0 ? '+' : '') + x.toFixed(1) + '%';

const trendArrow = (x) => (x > TREND_BAND ? '▲' : x < -TREND_BAND ? '▼' : '≈');

// result: { mean, items: [{ symbol, r, rui }], failures: [symbol] }
// weeklyResult (опционально): результат getBasketReturns('7d') — колонка недельной тенденции
export function formatRuiReport(result, windowLabel, weeklyResult = null) {
  const windowRu = WINDOW_LABELS_RU[windowLabel] ?? windowLabel;
  const weeklyBySymbol = weeklyResult
    ? new Map(weeklyResult.items.map((it) => [it.symbol, it.r]))
    : null;
  const lines = [
    'Индекс относительной недооцененности (RUI)',
    `Окно: ${windowRu} | Средняя доходность корзины M = ${fmtPct(result.mean)}`,
    '',
    weeklyBySymbol
      ? `${'RUI'.padStart(7)}  ${`R ${windowRu}`.padStart(7)}  ${'R 7д'.padStart(8)}  Монета`
      : `${'RUI'.padStart(7)}  ${'R'.padStart(7)}  Монета`,
  ];

  for (const item of result.items) {
    let marker = '';
    if (item.rui > PARITY_BAND) marker = '  <- отстала (недооценена)';
    else if (item.rui < -PARITY_BAND) marker = '  <- перегрета';
    let row = `${fmtPct(item.rui).padStart(7)}  ${fmtPct(item.r).padStart(7)}`;
    if (weeklyBySymbol) {
      const w = weeklyBySymbol.get(item.symbol);
      const cell = w == null ? '—' : `${fmtPct1(w)} ${trendArrow(w)}`;
      row += `  ${cell.padStart(8)}`;
    }
    lines.push(`${row}  ${item.symbol}${marker}`);
  }

  if (result.failures?.length) {
    lines.push('', `! Не удалось получить: ${result.failures.join(', ')}`);
  }
  return lines.join('\n');
}
