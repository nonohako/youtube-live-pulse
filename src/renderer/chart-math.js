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
    const cutoff = rangeStartTime(range, now);
    if (!Number.isFinite(cutoff)) return samples;
    return samples.filter((sample) => sample.timestamp >= cutoff);
  }

  function rangeStartTime(range = '30d', now = Date.now()) {
    const numericNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (range === '1y') return startOfLocalDay(shiftLocalMonths(numericNow, -12));
    const days = RANGE_DAYS[range];
    if (!days) return null;
    return shiftLocalDays(startOfLocalDay(numericNow), -(days - 1));
  }

  function filterSamplesWithBaseline(history, range = '30d', now = Date.now()) {
    const samples = normalizeSamples(history);
    const cutoff = rangeStartTime(range, now);
    if (!Number.isFinite(cutoff)) return samples;
    const firstVisibleIndex = samples.findIndex((sample) => sample.timestamp >= cutoff);
    if (firstVisibleIndex < 0) return samples.length ? [samples.at(-1)] : [];
    return samples.slice(Math.max(0, firstVisibleIndex - 1));
  }

  function filterSamplesInTimeWindow(history, startTime, endTime) {
    const lower = Math.min(Number(startTime), Number(endTime));
    const upper = Math.max(Number(startTime), Number(endTime));
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) return [];
    return normalizeSamples(history).filter((sample) => (
      sample.timestamp >= lower && sample.timestamp <= upper
    ));
  }

  function filterSamplesWithBaselineInTimeWindow(history, startTime, endTime) {
    const lower = Math.min(Number(startTime), Number(endTime));
    const upper = Math.max(Number(startTime), Number(endTime));
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) return [];
    const samples = normalizeSamples(history).filter((sample) => sample.timestamp <= upper);
    const firstVisibleIndex = samples.findIndex((sample) => sample.timestamp >= lower);
    if (firstVisibleIndex < 0) return [];
    return samples.slice(Math.max(0, firstVisibleIndex - 1));
  }

  function collapseSamplesByLocalDate(history) {
    const closes = [];
    for (const sample of normalizeSamples(history)) {
      const timestamp = startOfLocalDay(sample.timestamp);
      const close = {
        at: new Date(timestamp).toISOString(),
        timestamp,
        count: sample.count
      };
      if (closes.at(-1)?.timestamp === timestamp) {
        closes[closes.length - 1] = close;
      } else {
        closes.push(close);
      }
    }
    return closes;
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

  function buildCompletedDayAxis(dailySamples) {
    const days = (Array.isArray(dailySamples) ? dailySamples : [])
      .map((sample) => Number(sample?.dayTimestamp))
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    const start = days[0] ?? startOfLocalDay(Date.now());
    const last = days.at(-1) ?? start;
    const spanDays = Math.max(0, localCalendarDayDifference(start, last));
    return {
      startTime: start,
      endTime: Math.max(last, start + 1),
      ticks: buildCalendarTicks(start, last, spanDays)
    };
  }

  function buildTimeWindowAxis(startTime, endTime) {
    const lower = Math.min(Number(startTime), Number(endTime));
    const upper = Math.max(Number(startTime), Number(endTime));
    const safeStart = Number.isFinite(lower) ? lower : Date.now();
    const safeEnd = Number.isFinite(upper) ? Math.max(upper, safeStart + 1) : safeStart + 1;
    const firstDay = startOfLocalDay(safeStart);
    const firstTick = firstDay < safeStart ? shiftLocalDays(firstDay, 1) : firstDay;
    const spanDays = Math.max(0, Math.ceil((safeEnd - safeStart) / DAY_MS));
    return {
      startTime: safeStart,
      endTime: safeEnd,
      ticks: buildCalendarTicks(firstTick, safeEnd, spanDays)
        .filter((tick) => tick >= safeStart && tick <= safeEnd)
    };
  }

  function zoomTimeWindow(currentWindow, fullWindow, anchorTime, scale, minimumSpan = DAY_MS) {
    const fullStart = Math.min(Number(fullWindow?.startTime), Number(fullWindow?.endTime));
    const fullEnd = Math.max(Number(fullWindow?.startTime), Number(fullWindow?.endTime));
    if (!Number.isFinite(fullStart) || !Number.isFinite(fullEnd) || fullEnd <= fullStart) {
      return null;
    }

    const currentStart = Math.max(fullStart, Math.min(
      Number(currentWindow?.startTime),
      Number(currentWindow?.endTime)
    ));
    const currentEnd = Math.min(fullEnd, Math.max(
      Number(currentWindow?.startTime),
      Number(currentWindow?.endTime)
    ));
    const safeCurrentStart = Number.isFinite(currentStart) && currentEnd > currentStart
      ? currentStart
      : fullStart;
    const safeCurrentEnd = Number.isFinite(currentEnd) && currentEnd > currentStart
      ? currentEnd
      : fullEnd;
    const fullSpan = fullEnd - fullStart;
    const currentSpan = safeCurrentEnd - safeCurrentStart;
    const safeScale = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
    const minSpan = Math.min(fullSpan, Math.max(1, Number(minimumSpan) || DAY_MS));
    const nextSpan = Math.min(fullSpan, Math.max(minSpan, currentSpan * safeScale));
    if (nextSpan >= fullSpan - 1) {
      return { startTime: fullStart, endTime: fullEnd };
    }

    const safeAnchor = Math.min(safeCurrentEnd, Math.max(
      safeCurrentStart,
      Number.isFinite(Number(anchorTime)) ? Number(anchorTime) : (safeCurrentStart + safeCurrentEnd) / 2
    ));
    const anchorRatio = currentSpan > 0 ? (safeAnchor - safeCurrentStart) / currentSpan : 0.5;
    let nextStart = safeAnchor - nextSpan * anchorRatio;
    let nextEnd = nextStart + nextSpan;
    if (nextStart < fullStart) {
      nextStart = fullStart;
      nextEnd = fullStart + nextSpan;
    }
    if (nextEnd > fullEnd) {
      nextEnd = fullEnd;
      nextStart = fullEnd - nextSpan;
    }
    return { startTime: nextStart, endTime: nextEnd };
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
          previousCount: null,
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
        previousCount: previous.count,
        elapsedDays,
        rawChange,
        dailyChange,
        growthRate
      };
    });
  }

  function analyzeGrowth(samples, now = Date.now(), visibleStartTime = null) {
    const currentDayStart = startOfLocalDay(now);
    const visibleDayStart = visibleStartTime !== null
      && visibleStartTime !== undefined
      && Number.isFinite(Number(visibleStartTime))
      ? startOfLocalDay(Number(visibleStartTime))
      : null;
    const allDaily = buildDailySeries(samples);
    const daily = allDaily.filter((sample) => sample.dayTimestamp < currentDayStart
      && (visibleDayStart === null || sample.dayTimestamp >= visibleDayStart));
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
      excludedCurrentDay: allDaily.some((sample) => sample.dayTimestamp >= currentDayStart),
      latestCompletedAt: daily.at(-1)?.dayTimestamp ?? null,
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

  function analyzeGrowthForRange(history, range = '30d', now = Date.now()) {
    return analyzeGrowth(
      filterSamplesWithBaseline(history, range, now),
      now,
      rangeStartTime(range, now)
    );
  }

  function analyzeGrowthForTimeWindow(history, startTime, endTime, now = Date.now()) {
    const lower = Math.min(Number(startTime), Number(endTime));
    const upper = Math.max(Number(startTime), Number(endTime));
    const visibleDayStart = startOfLocalDay(lower);
    const visibleDayEnd = shiftLocalDays(startOfLocalDay(upper), 1) - 1;
    return analyzeGrowth(
      filterSamplesWithBaselineInTimeWindow(history, visibleDayStart, visibleDayEnd),
      now,
      visibleDayStart
    );
  }

  function summarizeDailyRange(dailySamples, startTime, endTime) {
    const lower = Math.min(Number(startTime), Number(endTime));
    const upper = Math.max(Number(startTime), Number(endTime));
    const selected = (Array.isArray(dailySamples) ? dailySamples : [])
      .filter((sample) => Number.isFinite(sample?.dayTimestamp)
        && sample.dayTimestamp >= lower
        && sample.dayTimestamp <= upper)
      .sort((left, right) => left.dayTimestamp - right.dayTimestamp);
    const changes = selected.filter((sample) => Number.isFinite(sample.dailyChange));
    const rates = selected.filter((sample) => Number.isFinite(sample.growthRate));
    const firstChange = changes[0];
    const last = selected.at(-1);
    const baseline = firstChange?.previousCount;

    return {
      selected,
      startTime: selected[0]?.dayTimestamp ?? null,
      endTime: last?.dayTimestamp ?? null,
      dayCount: selected.length,
      totalChange: changes.length
        ? changes.reduce((sum, sample) => sum + sample.rawChange, 0)
        : null,
      averageDailyChange: changes.length
        ? average(changes.map((sample) => sample.dailyChange))
        : null,
      averageGrowthRate: rates.length
        ? average(rates.map((sample) => sample.growthRate))
        : null,
      periodGrowthRate: Number.isFinite(baseline) && baseline > 0 && last
        ? ((last.count - baseline) / baseline) * 100
        : null,
      slopePerDay: selected.length >= 2
        ? linearRegression(selected).slopePerDay
        : null
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
    analyzeGrowthForRange,
    analyzeGrowthForTimeWindow,
    buildCompletedDayAxis,
    buildDailySeries,
    buildTimeAxis,
    buildTimeWindowAxis,
    collapseSamplesByLocalDate,
    filterSamples,
    filterSamplesInTimeWindow,
    filterSamplesWithBaseline,
    filterSamplesWithBaselineInTimeWindow,
    linearRegression,
    normalizeSamples,
    rangeStartTime,
    summarizeDailyRange,
    summarizeSamples,
    zoomTimeWindow
  };
}));
