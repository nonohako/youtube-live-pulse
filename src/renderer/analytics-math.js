(function(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./chart-math') : root.LivePulseChartMath);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LivePulseAnalytics = api;
})(globalThis, (math) => {
  'use strict';
  const ranges = ['7d', '30d', '90d', '1y', 'all'];
  function preferences(value = {}) {
    const result = {};
    for (const name of ['subscriber', 'video', 'compare']) {
      result[name + 'Range'] = ranges.includes(value?.[name + 'Range']) ? value[name + 'Range'] : '30d';
      result[name + 'Mode'] = value?.[name + 'Mode'] === 'daily' ? 'daily' : 'samples';
    }
    result.compareMetric = value?.compareMetric === 'change' ? 'change' : 'total';
    return result;
  }
  function comparison(items, range, mode, metric, now = Date.now()) {
    const series = items.map(item => {
      const raw = math.filterSamples(item.samples, range, now).filter(s => s.timestamp <= now);
      const summary = intervalSummary(raw);
      const baseline = summary.first?.count;
      const closes = new Map();
      for (const sample of raw) {
        const day = new Date(sample.timestamp); day.setHours(0, 0, 0, 0);
        closes.set(day.getTime(), sample);
      }
      const samples = mode === 'daily'
        ? [...closes].map(([timestamp, sample]) => ({...sample, timestamp, observedAt: sample.timestamp}))
        : raw.map(sample => ({...sample, observedAt: sample.timestamp}));
      return {...item, samples: samples.map(s => ({...s, value: metric === 'change' ? s.count - baseline : s.count})),
        ...summary, baseline};
    });
    const samples = series.flatMap(s => s.samples);
    const times = samples.map(s => s.timestamp);
    const values = samples.map(s => s.value);
    return {series, start: times.length ? Math.min(...times) : now, end: times.length ? Math.max(...times) : now,
      low: values.length ? Math.min(0, ...values) : 0, high: values.length ? Math.max(1, ...values) : 1};
  }
  function intervalSummary(history) {
    const samples = math.normalizeSamples(history);
    const first = samples[0], last = samples.at(-1);
    const days = first && last ? (last.timestamp - first.timestamp) / 86400000 : 0;
    const change = samples.length > 1 && days > 0 ? last.count - first.count : null;
    return {first, last, change, perDay: change === null ? null : change / days,
      percent: change === null || first.count <= 0 ? null : change / first.count * 100};
  }
  const DAY = 86400000;
  const Z80 = 1.2816; // two-sided 80% interval

  // A projection from completed local days only (today is incomplete). It is an estimate for display,
  // never stored or mixed into observations. Subscribers: constant drift over the last 28 days.
  // Video views: daily gains decaying exponentially, fitted on the last 14 days.
  function forecast(history, kind = 'subscriber', now = Date.now()) {
    const samples = math.normalizeSamples(history);
    const anchor = samples.filter(s => s.timestamp <= now).at(-1);
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const closes = math.buildDailySeries(samples).filter(c => c.dayTimestamp < today.getTime());
    const result = {ready: false, kind, anchor, ...momentum(closes)};
    if (!anchor || closes.length < 2) return {...result, reason: '완료된 날짜 기록이 더 필요합니다.'};
    const windowDays = kind === 'video' ? 14 : 28;
    const lastDay = closes.at(-1).dayTimestamp;
    const inWindow = closes.filter(c => c.dayTimestamp >= lastDay - windowDays * DAY - DAY / 2);
    const span = Math.round((lastDay - inWindow[0].dayTimestamp) / DAY);
    const model = kind === 'video' ? decayModel(inWindow, anchor) : driftModel(inWindow, span);
    if (!model) return {...result, reason: kind === 'video'
      ? '조회수가 늘어난 완료일이 4일 이상 필요합니다.' : '완료된 날짜 7일 이상이 필요합니다.'};
    const project = days => {
      const h = Math.max(0, days);
      const [low, mid, high] = model.gain(h);
      return {value: anchor.count + mid, low: anchor.count + low, high: anchor.count + high};
    };
    return {...result, ready: true, ...model.info, windowDays: span, project,
      milestone: milestone(anchor, model)};
  }

  function driftModel(closes, span) {
    if (span < 6) return null;
    const rate = (closes.at(-1).count - closes[0].count) / span;
    let squares = 0, weight = 0;
    for (const c of closes.slice(1)) { squares += c.elapsedDays * (c.dailyChange - rate) ** 2; weight += c.elapsedDays; }
    const sigma = Math.sqrt(squares / weight), se = sigma / Math.sqrt(span);
    return {info: {rate}, rate,
      gain: h => { const half = Z80 * Math.sqrt(h * sigma ** 2 + (h * se) ** 2); return [rate * h - half, rate * h, rate * h + half]; },
      daysTo: need => rate > 0 ? need / rate : null};
  }

  function decayModel(closes, anchor) {
    // Each gain is the average over (previous close, close]; place it at that interval's midpoint.
    const points = closes.slice(1).filter(c => c.dailyChange > 0).map(c => ({
      t: (c.timestamp - c.elapsedDays * DAY / 2 - anchor.timestamp) / DAY, y: Math.log(c.dailyChange)}));
    if (points.length < 4) return null;
    const mx = points.reduce((s, p) => s + p.t, 0) / points.length;
    const my = points.reduce((s, p) => s + p.y, 0) / points.length;
    const sxx = points.reduce((s, p) => s + (p.t - mx) ** 2, 0);
    if (!sxx) return null;
    const clamp = b => Math.max(Math.log(0.5), Math.min(Math.log(1.05), b));
    const rawSlope = points.reduce((s, p) => s + (p.t - mx) * (p.y - my), 0) / sxx;
    const slope = clamp(rawSlope);
    const level = my - slope * mx; // log daily gain at the anchor time
    const sigma = Math.sqrt(points.reduce((s, p) => s + (p.y - level - slope * p.t) ** 2, 0) / Math.max(1, points.length - 2));
    const seSlope = sigma / Math.sqrt(sxx), seLevel = sigma * Math.sqrt(1 / points.length + mx ** 2 / sxx);
    const total = (a, b, h) => Math.exp(a) * (Math.abs(b) < 1e-9 ? h : (Math.exp(b * h) - 1) / b);
    const rate = Math.exp(level);
    return {info: {rate, halfLifeDays: slope < 0 ? Math.log(2) / -slope : null}, rate,
      gain: h => [total(level - Z80 * seLevel, clamp(slope - Z80 * seSlope), h), total(level, slope, h),
        total(level + Z80 * seLevel, clamp(slope + Z80 * seSlope), h)],
      daysTo: need => {
        if (Math.abs(slope) < 1e-9) return need / rate;
        const inner = 1 + need * slope / rate;
        return inner > 0 ? Math.log(inner) / slope : null;
      }};
  }

  function momentum(closes) {
    // Average gain per day over the latest 7 completed days versus the 7 before, from real closes only.
    const last = closes.at(-1);
    if (!last) return {recent: null, previous: null, momentum: null};
    const before = days => closes.filter(c => c.dayTimestamp <= last.dayTimestamp - days * DAY + DAY / 2).at(-1);
    const perDay = (a, b) => a && b && a.dayTimestamp > b.dayTimestamp ? (a.count - b.count) / Math.round((a.dayTimestamp - b.dayTimestamp) / DAY) : null;
    const middle = before(7), start = middle && before(14);
    const recent = perDay(last, middle), previous = perDay(middle, start);
    return {recent, previous, momentum: recent !== null && previous > 0 ? recent / previous - 1 : null};
  }

  function nextMilestone(count) {
    const step = 10 ** Math.max(1, Math.floor(Math.log10(Math.max(1, count))) - 1);
    return (Math.floor(count / step) + 1) * step;
  }

  function milestone(anchor, model) {
    const target = nextMilestone(anchor.count);
    const days = model.daysTo(target - anchor.count);
    return {target, days: days !== null && days <= 3650 ? days : null,
      timestamp: days !== null && days <= 3650 ? anchor.timestamp + days * DAY : null};
  }

  return {preferences, comparison, intervalSummary, forecast, nextMilestone};
});
