(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LivePulseChartHover = api;
})(globalThis, () => {
  'use strict';
  function nearest(points, value, key = 'x') {
    if (!points.length) return null;
    let low = 0, high = points.length;
    while (low < high) { const middle = (low + high) >>> 1; if (points[middle][key] < value) low = middle + 1; else high = middle; }
    if (!low) return points[0];
    if (low === points.length) return points.at(-1);
    return value - points[low - 1][key] <= points[low][key] - value ? points[low - 1] : points[low];
  }
  function scheduler(request, cancel) {
    const pending = new Map();
    return {
      move(key, event, callback) {
        const current = pending.get(key);
        if (current) { current.event = event; return; }
        const entry = {event}; pending.set(key, entry);
        entry.id = request(() => { pending.delete(key); callback(entry.event); });
      },
      clear(key) { const entry = pending.get(key); if (entry) {cancel(entry.id); pending.delete(key);} }
    };
  }
  return {nearest, scheduler};
});
