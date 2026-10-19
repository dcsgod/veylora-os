// Transparent baseline forecasting methods. These are textbook baselines, not tuned production models.

export function movingAverage(series, window = 4) {
  if (!series.length) return 0;
  const slice = series.slice(-window);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export function exponentialSmoothing(series, alpha = 0.3) {
  if (!series.length) return 0;
  let level = series[0];
  for (let i = 1; i < series.length; i += 1) level = alpha * series[i] + (1 - alpha) * level;
  return level;
}

export function holtLinear(series, alpha = 0.3, beta = 0.1) {
  if (series.length < 2) return { level: series[0] ?? 0, trend: 0 };
  let level = series[0];
  let trend = series[1] - series[0];
  for (let i = 1; i < series.length; i += 1) {
    const prevLevel = level;
    level = alpha * series[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  return { level, trend };
}

export const METHODS = ['moving_average', 'exponential_smoothing', 'holt'];

export function forecast(series, { method = 'exponential_smoothing', horizon = 8, window = 4, alpha = 0.3, beta = 0.1 } = {}) {
  if (!METHODS.includes(method)) throw new Error(`unknown method ${method}`);
  const out = [];
  if (method === 'holt') {
    const { level, trend } = holtLinear(series, alpha, beta);
    for (let h = 1; h <= horizon; h += 1) out.push(Math.max(0, level + h * trend));
  } else {
    const value = method === 'moving_average' ? movingAverage(series, window) : exponentialSmoothing(series, alpha);
    for (let h = 1; h <= horizon; h += 1) out.push(Math.max(0, value));
  }
  return out.map((v) => Math.round(v * 100) / 100);
}

export function stdDev(series) {
  if (series.length < 2) return 0;
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const variance = series.reduce((a, b) => a + (b - mean) ** 2, 0) / (series.length - 1);
  return Math.sqrt(variance);
}

// Rolling-origin one-step backtest over the last `holdout` points. Reports error honestly; no claims beyond this data.
export function backtest(series, method = 'exponential_smoothing', holdout = 8) {
  const errors = [];
  for (let t = series.length - holdout; t < series.length; t += 1) {
    if (t < 2) continue;
    const predicted = forecast(series.slice(0, t), { method, horizon: 1 })[0];
    errors.push({ actual: series[t], predicted });
  }
  if (!errors.length) return { method, points: 0, mae: null, mape: null };
  const mae = errors.reduce((a, e) => a + Math.abs(e.actual - e.predicted), 0) / errors.length;
  const nonZero = errors.filter((e) => e.actual !== 0);
  const mape = nonZero.length ? (nonZero.reduce((a, e) => a + Math.abs(e.actual - e.predicted) / e.actual, 0) / nonZero.length) * 100 : null;
  return { method, points: errors.length, mae: round2(mae), mape: mape === null ? null : round2(mape) };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
