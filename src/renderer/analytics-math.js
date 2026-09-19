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
      result[name + 'Metric'] = value?.[name + 'Metric'] === 'change' ? 'change' : 'total';
      result[name + 'Mode'] = value?.[name + 'Mode'] === 'daily' ? 'daily' : 'samples';
    }
    result.compareMetric = value?.compareMetric === 'change' ? 'change' : 'total';
    return result;
  }
  function comparison(items, range, mode, metric, now = Date.now()) {
    const series = items.map(item => {
      const history = mode === 'daily' ? math.collapseSamplesByLocalDate(item.samples) : item.samples;
      const samples = math.filterSamples(history, range, now).filter(s => s.timestamp <= now);
      const baseline = samples[0]?.count;
      return {...item, samples: samples.map(s => ({...s, value: metric === 'change' ? s.count - baseline : s.count})),
        first: samples[0], last: samples.at(-1), change: samples.length >= 2 ? samples.at(-1).count - baseline : null};
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
  return {preferences, comparison, intervalSummary};
});
