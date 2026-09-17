'use strict';

const VIDEO_HISTORY_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const VIDEO_HISTORY_HEARTBEAT_MS = 6 * 60 * 60 * 1000;
const MAX_VIDEO_HISTORIES = 100;
const MAX_VIDEO_SAMPLES = 2000;

function normalizeVideoViewHistories(histories, now = Date.now(), options = {}) {
  const referenceTime = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const cutoff = options.retainAll ? 0 : referenceTime - VIDEO_HISTORY_RETENTION_MS;
  return (Array.isArray(histories) ? histories : [])
    .map((history) => normalizeVideoHistory(history, cutoff, options.sampleLimit ?? MAX_VIDEO_SAMPLES))
    .filter((history) => history?.samples?.length)
    .sort(compareHistories)
    .slice(0, options.retainAll ? Infinity : MAX_VIDEO_HISTORIES);
}

function mergeVideoViewStatistics(histories, statistics, checkedAt = new Date().toISOString()) {
  const checkedTimestamp = new Date(checkedAt).getTime();
  if (!Number.isFinite(checkedTimestamp)) {
    return normalizeVideoViewHistories(histories);
  }
  const byId = new Map(normalizeVideoViewHistories(histories, checkedTimestamp)
    .map((history) => [history.videoId, history]));
  const cutoff = checkedTimestamp - VIDEO_HISTORY_RETENTION_MS;

  for (const statistic of Array.isArray(statistics) ? statistics : []) {
    const videoId = String(statistic?.id || statistic?.videoId || '');
    const count = Number(statistic?.viewCount);
    if (!/^[\w-]{11}$/.test(videoId) || !Number.isFinite(count) || count < 0) continue;
    const existing = byId.get(videoId) || {
      videoId,
      title: '제목 없음',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnailUrl: '',
      publishedAt: null,
      lastCheckedAt: null,
      source: 'page',
      samples: []
    };
    const samples = normalizeSamples(existing.samples).filter((sample) => sample.timestamp >= cutoff);
    const last = samples.at(-1);
    if (!last || last.count !== count || checkedTimestamp - last.timestamp >= VIDEO_HISTORY_HEARTBEAT_MS) {
      samples.push({
        at: new Date(checkedTimestamp).toISOString(),
        timestamp: checkedTimestamp,
        count: Math.round(count)
      });
    }
    existing.title = String(statistic.title || existing.title || '제목 없음').slice(0, 500);
    existing.url = `https://www.youtube.com/watch?v=${videoId}`;
    existing.thumbnailUrl = safeHttpsUrl(statistic.thumbnailUrl) || existing.thumbnailUrl || '';
    existing.publishedAt = validIsoDate(statistic.publishedAt) || existing.publishedAt || null;
    existing.lastCheckedAt = new Date(checkedTimestamp).toISOString();
    existing.source = statistic.source === 'api' ? 'api' : 'page';
    existing.samples = compactSamples(samples, MAX_VIDEO_SAMPLES).map(({ at, count: sampleCount }) => ({
      at,
      count: sampleCount
    }));
    byId.set(videoId, existing);
  }

  return [...byId.values()]
    .map((history) => normalizeVideoHistory(history, cutoff))
    .filter((history) => history?.samples?.length)
    .sort(compareHistories)
    .slice(0, MAX_VIDEO_HISTORIES);
}

function normalizeVideoHistory(history, cutoff = Date.now() - VIDEO_HISTORY_RETENTION_MS, sampleLimit = MAX_VIDEO_SAMPLES) {
  const videoId = String(history?.videoId || history?.id || '');
  if (!/^[\w-]{11}$/.test(videoId)) return null;
  const samples = compactSamples(
    normalizeSamples(history.samples).filter((sample) => sample.timestamp >= cutoff),
    sampleLimit
  );
  return {
    videoId,
    title: String(history.title || '제목 없음').slice(0, 500),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnailUrl: safeHttpsUrl(history.thumbnailUrl),
    publishedAt: validIsoDate(history.publishedAt),
    lastCheckedAt: validIsoDate(history.lastCheckedAt) || samples.at(-1)?.at || null,
    source: history.source === 'api' ? 'api' : 'page',
    samples: samples.map(({ at, count }) => ({ at, count }))
  };
}

function normalizeSamples(samples) {
  return (Array.isArray(samples) ? samples : [])
    .map((sample) => ({
      at: validIsoDate(sample?.at),
      timestamp: new Date(sample?.at).getTime(),
      count: Math.round(Number(sample?.count))
    }))
    .filter((sample) => sample.at && Number.isFinite(sample.timestamp)
      && Number.isFinite(sample.count) && sample.count >= 0)
    .sort((left, right) => left.timestamp - right.timestamp);
}

function compactSamples(samples, limit) {
  if (samples.length <= limit) return samples;
  if (limit <= 1) return [samples.at(-1)];
  const lastIndex = samples.length - 1;
  const selected = [];
  let previousIndex = -1;
  for (let slot = 0; slot < limit; slot += 1) {
    const index = Math.round((slot / (limit - 1)) * lastIndex);
    if (index !== previousIndex) selected.push(samples[index]);
    previousIndex = index;
  }
  return selected;
}

function compareHistories(left, right) {
  return dateValue(right.publishedAt || right.lastCheckedAt)
    - dateValue(left.publishedAt || left.lastCheckedAt);
}

function dateValue(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function validIsoDate(value) {
  const timestamp = new Date(value || '').getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

module.exports = {
  MAX_VIDEO_HISTORIES,
  MAX_VIDEO_SAMPLES,
  VIDEO_HISTORY_HEARTBEAT_MS,
  VIDEO_HISTORY_RETENTION_MS,
  compactSamples,
  mergeVideoViewStatistics,
  normalizeVideoViewHistories
};
