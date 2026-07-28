(function exposeChartMath(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.LivePulseChartMath = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const RANGE_DAYS = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
    '1y': 365
  };

  function normalizeSamples(history) {
    return (Array.isArray(history) ? history : [])
      .map((sample) => ({
        at: sample?.at,
        timestamp: new Date(sample?.at).getTime(),
        count: Number(sample?.count)
      }))
      .filter((sample) => Number.isFinite(sample.timestamp) && Number.isFinite(sample.count))
      .sort((left, right) => left.timestamp - right.timestamp);
  }

  function filterSamples(history, range = '30d', now = Date.now()) {
    const samples = normalizeSamples(history);
    const days = RANGE_DAYS[range];
    if (!days) return samples;
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    return samples.filter((sample) => sample.timestamp >= cutoff);
  }

  function linearRegression(samples) {
    const normalized = normalizeSamples(samples);
    if (!normalized.length) return { slopePerDay: 0, intercept: 0, values: [] };

    const origin = normalized[0].timestamp;
    const points = normalized.map((sample) => ({
      x: (sample.timestamp - origin) / (24 * 60 * 60 * 1000),
      y: sample.count
    }));
    const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
    const slopePerDay = denominator
      ? points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator
      : 0;
    const intercept = meanY - slopePerDay * meanX;

    return {
      slopePerDay,
      intercept,
      values: points.map((point) => intercept + slopePerDay * point.x)
    };
  }

  function summarizeSamples(samples) {
    const normalized = normalizeSamples(samples);
    if (!normalized.length) {
      return {
        current: null,
        change: 0,
        high: null,
        low: null,
        slopePerDay: 0
      };
    }
    const values = normalized.map((sample) => sample.count);
    const trend = linearRegression(normalized);
    return {
      current: values.at(-1),
      change: values.at(-1) - values[0],
      high: Math.max(...values),
      low: Math.min(...values),
      slopePerDay: trend.slopePerDay
    };
  }

  return {
    RANGE_DAYS,
    filterSamples,
    linearRegression,
    normalizeSamples,
    summarizeSamples
  };
}));
