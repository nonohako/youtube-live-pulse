'use strict';

function eventDedupKey(event) {
  if (!event?.channelId || !event?.type) return null;
  const subject = event.sourceId || event.url || event.detail;
  if (!subject) return null;
  return `${event.channelId}|${event.type}|${subject}`;
}

function dedupeEvents(events, limit = 100) {
  if (!Array.isArray(events)) return [];
  const seen = new Set();
  const deduped = [];

  for (const event of events) {
    const key = eventDedupKey(event);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    deduped.push(event);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

module.exports = { dedupeEvents, eventDedupKey };
