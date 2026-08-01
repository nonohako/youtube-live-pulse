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
    const cutoff = range === '1y' ? shiftLocalMonths(now, -12) : now - days * DAY_MS;
    return samples.filter((sample) => sample.timestamp >= cutoff);
  }

  function buildTimeAxis(samples, _range = '30d', now = Date.now()) {
    const normalized = normalizeSamples(samples);
    const end = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const firstSampleTime = normalized[0]?.timestamp ?? end;
    const start = startOfLocalDay(firstSampleTime);
    const spanDays = Math.max(0, Math.ceil((end - start) / DAY_MS));
    return {
      startTime: start,
      endTime: Math.max(end, start + 1),
      ticks: buildCalendarTicks(start, end, spanDays)
    };
  }

  function buildCalendarTicks(startTime, endTime, spanDays) {
    if (spanDays <= 10) return buildLocalDayTicks(startTime, endTime, 1);
    if (spanDays <= 45) return buildLocalDayTicks(startTime, endTime, 5);
    if (spanDays <= 120) return buildLocalDayTicks(startTime, endTime, 15);
    return buildLocalMonthTicks(startTime, endTime, 3);
  }

  function buildLocalDayTicks(startTime, endTime, stepDays) {
    const ticks = [];
    for (let index = 0; index < 500; index += 1) {
      const tick = shiftLocalDays(startTime, index * stepDays);
      if (tick > endTime) break;
      ticks.push(tick);
    }
    return ticks.length ? ticks : [startTime];
  }

  function buildLocalMonthTicks(startTime, endTime, stepMonths) {
    const ticks = [];
    for (let index = 0; index < 100; index += 1) {
      const tick = shiftLocalMonths(startTime, index * stepMonths);
      if (tick > endTime) break;
      ticks.push(tick);
    }
    return ticks.length ? ticks : [startTime];
  }

  function startOfLocalDay(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function shiftLocalDays(timestamp, dayDelta) {
    const shifted = new Date(timestamp);
    shifted.setDate(shifted.getDate() + dayDelta);
    return shifted.getTime();
  }

  function shiftLocalMonths(timestamp, monthDelta) {
    const source = new Date(timestamp);
    const day = source.getDate();
    const shifted = new Date(timestamp);
    shifted.setDate(1);
    shifted.setMonth(shifted.getMonth() + monthDelta);
    const lastDay = new Date(shifted.getFullYear(), shifted.getMonth() + 1, 0).getDate();
    shifted.setDate(Math.min(day, lastDay));
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

  function buildDailySeries(samples) {
    const closes = [];
    for (const sample of normalizeSamples(samples)) {
      const dayTimestamp = startOfLocalDay(sample.timestamp);
      const previousClose = closes.at(-1);
      const close = { ...sample, dayTimestamp };
      if (previousClose?.dayTimestamp === dayTimestamp) {
        closes[closes.length - 1] = close;
      } else {
        closes.push(close);
      }
    }

    return closes.map((close, index) => {
      const previous = closes[index - 1];
      if (!previous) {
        return {
          ...close,
          elapsedDays: null,
          rawChange: null,
          dailyChange: null,
          growthRate: null
        };
      }
      const elapsedDays = Math.max(1, localCalendarDayDifference(
        previous.dayTimestamp,
        close.dayTimestamp
      ));
      const rawChange = close.count - previous.count;
      const dailyChange = rawChange / elapsedDays;
      const growthRate = previous.count > 0
        ? (rawChange / previous.count / elapsedDays) * 100
        : null;
      return {
        ...close,
        elapsedDays,
        rawChange,
        dailyChange,
        growthRate
      };
    });
  }

  function analyzeGrowth(samples) {
    const daily = buildDailySeries(samples);
    const changes = daily.filter((sample) => Number.isFinite(sample.dailyChange));
    const latest = changes.at(-1);
    const previous = changes.at(-2);
    const accelerationChange = latest && previous
      ? latest.dailyChange - previous.dailyChange
      : null;

    const momentumWindow = 3;
    let recentMomentum = null;
    let previousMomentum = null;
    let momentumChange = null;
    if (changes.length >= momentumWindow * 2) {
      recentMomentum = average(changes.slice(-momentumWindow).map((sample) => sample.dailyChange));
      previousMomentum = average(
        changes.slice(-(momentumWindow * 2), -momentumWindow).map((sample) => sample.dailyChange)
      );
      momentumChange = recentMomentum - previousMomentum;
    }

    let earlierSlope = null;
    let laterSlope = null;
    let slopeChange = null;
    if (daily.length >= 4) {
      const midpoint = Math.floor(daily.length / 2);
      const earlier = daily.slice(0, midpoint);
      const later = daily.slice(midpoint);
      if (earlier.length >= 2 && later.length >= 2) {
        earlierSlope = linearRegression(earlier).slopePerDay;
        laterSlope = linearRegression(later).slopePerDay;
        slopeChange = laterSlope - earlierSlope;
      }
    }

    return {
      daily,
      latestDailyChange: latest?.dailyChange ?? null,
      latestGrowthRate: latest?.growthRate ?? null,
      accelerationChange,
      momentumWindow,
      recentMomentum,
      previousMomentum,
      momentumChange,
      earlierSlope,
      laterSlope,
      slopeChange
    };
  }

  function localCalendarDayDifference(startTimestamp, endTimestamp) {
    const start = new Date(startTimestamp);
    const end = new Date(endTimestamp);
    const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    const endDay = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
    return Math.round((endDay - startDay) / DAY_MS);
  }

  function average(values) {
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
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
    analyzeGrowth,
    buildDailySeries,
    buildTimeAxis,
    filterSamples,
    linearRegression,
    normalizeSamples,
    summarizeSamples
  };
}));
