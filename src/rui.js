// Чистая математика RUI, без I/O.

// returns: [{ symbol, r }] -> { mean, items: [{ symbol, r, rui }] }
// rui = mean - r; сортировка по rui по убыванию (самые отставшие — сверху)
export function computeRui(returns) {
  if (returns.length < 2) {
    throw new Error('для расчёта нужно минимум 2 монеты');
  }
  const mean = returns.reduce((sum, x) => sum + x.r, 0) / returns.length;
  const items = returns
    .map(({ symbol, r }) => ({ symbol, r, rui: mean - r }))
    .sort((a, b) => b.rui - a.rui);
  return { mean, items };
}
