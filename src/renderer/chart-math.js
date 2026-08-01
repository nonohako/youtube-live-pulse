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
  const DAY_MS = 24 * 60 * 60 * 1000;

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
    const cutoff = range === '1y' ? shiftUtcMonths(now, -12) : now - days * DAY_MS;
    return samples.filter((sample) => sample.timestamp >= cutoff);
  }

  function buildTimeAxis(samples, range = '30d', now = Date.now()) {
    const normalized = normalizeSamples(samples);
    const end = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const segments = { '7d': 7, '30d': 6, '90d': 6 }[range];
    if (segments) {
      const start = end - RANGE_DAYS[range] * DAY_MS;
      return {
        startTime: start,
        endTime: end,
        ticks: evenlySpacedTicks(start, end, segments)
      };
    }

    if (range === '1y') {
      const ticks = [12, 9, 6, 3, 0].map((monthsAgo) => shiftUtcMonths(end, -monthsAgo));
      return { startTime: ticks[0], endTime: end, ticks };
    }

    if (!normalized.length) {
      return {
        startTime: end - DAY_MS,
        endTime: end,
        ticks: evenlySpacedTicks(end - DAY_MS, end, 1)
      };
    }

    if (normalized.length === 1) {
      const middle = normalized[0].timestamp;
      return {
        startTime: middle - DAY_MS / 2,
        endTime: middle + DAY_MS / 2,
        ticks: evenlySpacedTicks(middle - DAY_MS / 2, middle + DAY_MS / 2, 2)
      };
    }

    const start = normalized[0].timestamp;
    const finish = normalized.at(-1).timestamp;
    return {
      startTime: start,
      endTime: finish,
      ticks: evenlySpacedTicks(start, finish, 6)
    };
  }

  function evenlySpacedTicks(startTime, endTime, segments) {
    const safeSegments = Math.max(1, Math.round(segments));
    return Array.from({ length: safeSegments + 1 }, (_, index) => (
      startTime + ((endTime - startTime) * index) / safeSegments
    ));
  }

  function shiftUtcMonths(timestamp, monthDelta) {
    const source = new Date(timestamp);
    const day = source.getUTCDate();
    const shifted = new Date(timestamp);
    shifted.setUTCDate(1);
    shifted.setUTCMonth(shifted.getUTCMonth() + monthDelta);
    const lastDay = new Date(Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth() + 1,
      0
    )).getUTCDate();
    shifted.setUTCDate(Math.min(day, lastDay));
    return shifted.getTime();
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
    buildTimeAxis,
    filterSamples,
    linearRegression,
    normalizeSamples,
    summarizeSamples
  };
}));
