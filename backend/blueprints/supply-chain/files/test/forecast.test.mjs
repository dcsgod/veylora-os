import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtest, exponentialSmoothing, forecast, holtLinear, METHODS, movingAverage, stdDev } from '../src/forecast.mjs';

test('moving average uses the trailing window', () => {
  assert.equal(movingAverage([1, 2, 3, 4, 5, 6], 3), 5);
  assert.equal(movingAverage([], 3), 0);
});

test('exponential smoothing of a constant series is the constant', () => {
  assert.equal(exponentialSmoothing([10, 10, 10, 10]), 10);
});

test('holt recovers a linear trend', () => {
  const series = Array.from({ length: 40 }, (_, i) => 100 + 5 * i);
  const { trend } = holtLinear(series);
  assert.ok(Math.abs(trend - 5) < 0.01);
  const f = forecast(series, { method: 'holt', horizon: 3 });
  assert.ok(Math.abs(f[0] - 300) < 1, `expected ~300 got ${f[0]}`);
  assert.ok(f[2] > f[0]);
});

test('forecast respects horizon, never negative, rejects unknown method', () => {
  for (const method of METHODS) assert.equal(forecast([5, 4, 3], { method, horizon: 6 }).length, 6);
  const declining = Array.from({ length: 20 }, (_, i) => 100 - 10 * i);
  assert.ok(forecast(declining, { method: 'holt', horizon: 10 }).every((v) => v >= 0));
  assert.throws(() => forecast([1], { method: 'magic' }), /unknown method/);
});

test('standard deviation', () => {
  assert.equal(stdDev([2, 4, 4, 4, 5, 5, 7, 9]).toFixed(4), '2.1381');
  assert.equal(stdDev([1]), 0);
});

test('backtest reports error metrics', () => {
  const r = backtest([10, 10, 10, 10, 10, 10, 10, 10, 10, 10], 'moving_average', 4);
  assert.deepEqual(r, { method: 'moving_average', points: 4, mae: 0, mape: 0 });
  assert.equal(backtest([1], 'holt', 4).mae, null);
});
