'use strict';

const { compactSamples, normalizeVideoViewHistories } = require('./video-history');

// Cloud pages replace channel archive objects; projections never mutate the archive.
const cloudProjectionCache = new WeakMap();
const mergedProjectionCache = new WeakMap();


function parseConnectionFile(text) {
  if (typeof text !== 'string' || text.length > 4096) throw new Error('클라우드 연결 파일 크기가 올바르지 않습니다.');
  const value = JSON.parse(text);
  const cloudUrl = normalizeCloudUrl(value?.cloudUrl);
  const cloudToken = String(value?.cloudToken || '').trim();
  if (!cloudUrl || !/^[A-Za-z0-9_-]{32,256}$/.test(cloudToken)) throw new Error('클라우드 연결 파일의 주소 또는 키를 확인하세요.');
  return { cloudUrl, cloudToken };
}

function normalizeCloudUrl(value) {
  if (!String(value || '').trim()) return '';
  const url = new URL(String(value).trim());
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.fly\.dev$/.test(url.hostname)
    || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') {
    throw new Error('클라우드 주소는 https://앱이름.fly.dev 형식이어야 합니다.');
  }
  return url.origin;
}

function samplesMerged(first, second, cutoff = 0, limit = Infinity) {
  const byTime = new Map();
  for (const sample of [...(first || []), ...(second || [])]) {
    const time = Date.parse(sample?.at);
    if (!Number.isFinite(time) || time <= cutoff || time > Date.now() + 60_000
      || !Number.isSafeInteger(sample.count) || sample.count < 0) continue;
    byTime.set(time, { at: new Date(time).toISOString(), count: sample.count });
  }
  return compactSamples([...byTime.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), limit);
}

function pruneCloud(cloud = {}, now = Date.now()) {
  cloud = cloud && typeof cloud === 'object' ? cloud : {};
  const channels = {};
  for (const [id, channel] of Object.entries(cloud.channels || {}).slice(0, 5)) {
    if (!/^UC[\w-]{22}$/.test(id)) continue;
    channels[id] = {
      // Keep downloaded history locally; server retention does not delete the archive.
      subscriberHistory: samplesMerged(channel.subscriberHistory, [], 0, Infinity),
      videoViewHistories: normalizeVideoViewHistories((channel.videoViewHistories || []).map((video) => ({
        ...video, samples: samplesMerged(video.samples, [], 0)
      })), now, { retainAll: true, sampleLimit: Infinity })
    };
  }
  return { ...cloud, channels };
}

function mergePage(cloud, page, allowedIds, now = Date.now()) {
  if (page?.version !== 1 || !Array.isArray(page.samples) || page.samples.length > 240) throw new Error('클라우드 응답 형식 오류');
  const next = pruneCloud(cloud, now);
  let cursor = Number(next.cursor) || 0;
  for (const sample of page.samples) {
    if (!Number.isSafeInteger(sample.at) || sample.at <= cursor || sample.at > now || !Array.isArray(sample.channels)) throw new Error('클라우드 기록 순서 오류');
    for (const entry of sample.channels) {
      if (!allowedIds.includes(entry.id)) continue;
      const target = next.channels[entry.id] ||= { subscriberHistory: [], videoViewHistories: [] };
      const at = new Date(sample.at).toISOString();
      if (Number.isSafeInteger(entry.subscriberCount) && entry.subscriberCount >= 0) target.subscriberHistory.push({ at, count: entry.subscriberCount });
      for (const [id, count] of Object.entries(entry.views || {}).slice(0, 100)) {
        if (!/^[\w-]{11}$/.test(id) || !Number.isSafeInteger(count) || count < 0) continue;
        let video = target.videoViewHistories.find((item) => item.videoId === id);
        if (!video) {
          const metadata = page.metadata?.[entry.id]?.videos?.[id];
          video = { videoId: id, title: String(metadata?.title || id).slice(0, 500), publishedAt: metadata?.publishedAt,
            url: `https://www.youtube.com/watch?v=${id}`, source: 'api', samples: [] };
          target.videoViewHistories.push(video);
        }
        video.samples.push({ at, count });
        video.lastCheckedAt = at;
      }
    }
    cursor = sample.at;
  }
  if (page.next !== cursor) throw new Error('클라우드 커서 오류');
  next.cursor = cursor;
  next.lastSyncAt = new Date(now).toISOString();
  next.lastCollectionAt = page.status?.lastSuccessAt || null;
  next.error = page.status?.error ? '서버 수집 오류 · 마지막 저장 기록을 표시합니다.' : null;
  if (next.lastCollectionAt && now - Date.parse(next.lastCollectionAt) > 180_000) next.error = '서버의 최근 수집이 3분 이상 지연되고 있습니다.';
  return pruneCloud(next, now);
}

function withCloudHistory(channel, cloud) {
  const extra = cloud?.channels?.[channel.id];
  if (!extra) return channel;
  const previous = mergedProjectionCache.get(channel);
  const subscriberLength = channel.subscriberHistory?.length || 0;
  if (previous?.extra === extra && previous.localSubscribers === channel.subscriberHistory
    && previous.subscriberLength === subscriberLength && previous.localVideos === channel.videoViewHistories) {
    return { ...channel, ...previous.histories };
  }
  let fresh = cloudProjectionCache.get(extra);
  if (!fresh) {
    fresh = {
      subscriberHistory: samplesMerged(extra.subscriberHistory, []),
      videoViewHistories: normalizeVideoViewHistories(extra.videoViewHistories, Date.now(), { retainAll: true, sampleLimit: 2000 })
    };
    cloudProjectionCache.set(extra, fresh);
  }
  const videos = new Map(fresh.videoViewHistories.map(video => [video.videoId, video]));
  for (const video of channel.videoViewHistories || []) {
    const other = videos.get(video.videoId);
    videos.set(video.videoId, { ...other, ...video, samples: samplesMerged(other?.samples, video.samples, 0, 2000) });
  }
  const histories = {
    subscriberHistory: samplesMerged(fresh.subscriberHistory, channel.subscriberHistory),
    videoViewHistories: [...videos.values()].sort((a,b) => Date.parse(b.publishedAt || b.lastCheckedAt || 0) - Date.parse(a.publishedAt || a.lastCheckedAt || 0))
  };
  mergedProjectionCache.set(channel, {extra, localSubscribers: channel.subscriberHistory, subscriberLength, localVideos: channel.videoViewHistories, histories});
  return { ...channel, ...histories };
}

class CloudSync {
  constructor({ store, onState, fetcher = fetch }) {
    this.store = store;
    this.onState = onState;
    this.fetch = fetcher;
    this.running = false;
    this.timer = null;
  }
  start() { this.stop(); void this.sync(); this.timer = setInterval(() => this.sync(), 60_000); }
  stop() { clearInterval(this.timer); this.timer = null; }
  async sync() {
    const { cloudUrl, cloudToken } = this.store.data.settings;
    if (this.running || !cloudUrl || !cloudToken) return;
    this.running = true;
    try {
      const endpoint = normalizeCloudUrl(cloudUrl);
      // Catch up in bounded pages; additional backlog is resumed in the next minute.
      for (let i = 0; i < 10; i += 1) {
        const cursor = this.store.data.cloud?.endpoint === endpoint && this.store.data.cloud.archiveVersion === 2 ? Number(this.store.data.cloud.cursor) || 0 : 0;
        const response = await this.fetch(`${endpoint}/v1/sync?after=${cursor}`, {
          headers: { Authorization: `Bearer ${cloudToken}` }, redirect: 'error', signal: AbortSignal.timeout(15_000)
        });
        if (!response.ok) throw new Error('클라우드 연결 실패 · 주소와 연결 키를 확인하세요.');
        const text = await response.text();
        if (text.length > 2_000_000) throw new Error('클라우드 응답이 너무 큽니다.');
        const page = JSON.parse(text);
        if (this.store.data.settings.cloudUrl !== cloudUrl || this.store.data.settings.cloudToken !== cloudToken) return;
        const base = { ...this.store.data.cloud, cursor };
        const merged = mergePage(base, page, this.store.data.channels.map((channel) => channel.id));
        merged.endpoint = endpoint;
        merged.archiveVersion = 2;
        this.store.update((data) => { data.cloud = merged; });
        if (!page.hasMore || !page.samples.length) break;
      }
    } catch {
      this.store.update((data) => { data.cloud = { ...pruneCloud(data.cloud), error: '클라우드 동기화 실패 · 기존 기록과 PC 감지는 유지됩니다.' }; });
    } finally {
      this.running = false;
      this.onState();
    }
  }
}

module.exports = { CloudSync, normalizeCloudUrl, mergePage, pruneCloud, withCloudHistory, parseConnectionFile };
