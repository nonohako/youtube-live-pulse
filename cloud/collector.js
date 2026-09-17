'use strict';

const MINUTE = 60_000;
const RETENTION_MS = 30 * 24 * 60 * MINUTE;
const PREFIX = 'live-pulse:v1';

class RedisStore {
  constructor(url, token, fetcher = fetch) {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.upstash.io')) throw new Error('Invalid Redis endpoint');
    this.url = endpoint.origin;
    this.token = token;
    this.fetch = fetcher;
    this.metadataCache = null;
    this.metadataWrittenAt = 0;
  }

  async commands(commands) {
    const response = await this.fetch(`${this.url}/multi-exec`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands)
    });
    if (!response.ok) throw new Error(`Storage HTTP ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result) || result.length !== commands.length || result.some((item) => item.error)) throw new Error('Storage command failed');
    return result.map((item) => item.result);
  }

  async save(sample, metadata) {
    const existing = await this.getMetadata();
    const merged = JSON.parse(JSON.stringify(existing));
    let newVideo = false;
    for (const [id, channel] of Object.entries(metadata)) {
      merged[id] = { title: channel.title, videos: { ...(merged[id]?.videos || {}) } };
      for (const [videoId, video] of Object.entries(channel.videos)) {
        if (!merged[id].videos[videoId]) newVideo = true;
        merged[id].videos[videoId] = { ...video, seenAt: sample.at };
      }
      for (const [videoId, video] of Object.entries(merged[id].videos)) {
        if (!Number.isFinite(video.seenAt) || video.seenAt <= sample.at - RETENTION_MS) delete merged[id].videos[videoId];
      }
    }
    for (const id of Object.keys(merged)) if (!Object.hasOwn(metadata, id)) delete merged[id];
    // A minute is a unique score. Retries replace that minute instead of duplicating it.
    const writeMetadata = newVideo || sample.at - this.metadataWrittenAt >= 5 * MINUTE;
    await this.commands([
      ['ZREMRANGEBYSCORE', `${PREFIX}:samples`, sample.at, sample.at],
      ['ZADD', `${PREFIX}:samples`, sample.at, JSON.stringify(sample)],
      ['ZREMRANGEBYSCORE', `${PREFIX}:samples`, '-inf', sample.at - RETENTION_MS],
      ['EXPIRE', `${PREFIX}:samples`, RETENTION_MS / 1000],
      ...(writeMetadata ? [['SET', `${PREFIX}:metadata`, JSON.stringify(merged), 'EX', RETENTION_MS / 1000]] : [])
    ]);
    this.metadataCache = merged;
    if (writeMetadata) this.metadataWrittenAt = sample.at;
  }

  async getMetadata() {
    if (this.metadataCache === null) {
      const [stored] = await this.commands([['GET', `${PREFIX}:metadata`]]);
      this.metadataCache = stored ? JSON.parse(stored) : {};
    }
    return this.metadataCache;
  }

  async read(after, now = Date.now()) {
    const cutoff = Math.max(after, now - RETENTION_MS);
    const metadata = await this.getMetadata();
    const [rows] = await this.commands([
      ['ZRANGEBYSCORE', `${PREFIX}:samples`, `(${cutoff}`, now, 'LIMIT', 0, 240]
    ]);
    const samples = (rows || []).map((row) => JSON.parse(row));
    return { version: 1, samples, metadata, next: samples.at(-1)?.at || after, hasMore: samples.length === 240 };
  }
}

class Collector {
  constructor({ channelIds, apiKey, store, fetcher = fetch, now = Date.now }) {
    if (!channelIds.length || channelIds.length > 5 || channelIds.some((id) => !/^UC[\w-]{22}$/.test(id))) throw new Error('Configure 1 to 5 channel IDs');
    if (!apiKey) throw new Error('YOUTUBE_API_KEY is required');
    this.channelIds = [...new Set(channelIds)];
    this.apiKey = apiKey;
    this.store = store;
    this.fetch = fetcher;
    this.now = now;
    this.playlists = new Map();
    this.videoState = new Map();
    this.running = false;
    this.lastSuccessAt = null;
    this.lastError = null;
  }

  async api(resource, parameters, full = false) {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    url.search = new URLSearchParams({ ...parameters, key: this.apiKey }).toString();
    const response = await this.fetch(url, { signal: AbortSignal.timeout(12_000), redirect: 'error' });
    if (!response.ok) throw new Error(`YouTube HTTP ${response.status}`);
    const data = await response.json();
    if (data.error || !Array.isArray(data.items)) throw new Error('Invalid YouTube response');
    return full ? data : data.items;
  }

  async collect() {
    if (this.running) return false;
    this.running = true;
    try {
      const channels = await this.api('channels', { part: 'snippet,statistics,contentDetails', id: this.channelIds.join(',') });
      const idsByChannel = new Map();
      for (const channel of channels) {
        if (!this.channelIds.includes(channel.id)) continue;
        let cached = this.playlists.get(channel.id);
        if (!cached || this.now() - cached.at >= 5 * MINUTE) {
          const playlistId = channel.contentDetails?.relatedPlaylists?.uploads;
          if (!playlistId) continue;
          const items = [];
          let pageToken;
          for (let page = 0; page < 3; page++) {
            const data = await this.api('playlistItems', { part: 'contentDetails', playlistId, maxResults: '50', ...(pageToken ? { pageToken } : {}) }, true);
            items.push(...data.items);
            pageToken = data.nextPageToken;
            if (!pageToken) break;
          }
          cached = { at: this.now(), ids: items.map((item) => item.contentDetails?.videoId).filter((id) => /^[\w-]{11}$/.test(id || '')) };
          this.playlists.set(channel.id, cached);
        }
        idsByChannel.set(channel.id, cached.ids);
      }
      const due = new Set();
      for (const [channelId, candidates] of idsByChannel) {
        const eligible = candidates.filter(id => !this.videoState.get(id)?.excluded).slice(0, 100);
        const fast = new Set(eligible.slice(0, 10));
        const ranked = eligible.slice(10).sort((a, b) => (this.videoState.get(b)?.rate || 0) - (this.videoState.get(a)?.rate || 0));
        for (const id of ranked.slice(0, 15)) fast.add(id);
        for (const [rank, id] of candidates.entries()) {
          const state = this.videoState.get(id);
          if (state && !state.excluded && !eligible.includes(id)) continue;
          const interval = state?.excluded ? 5 * MINUTE : fast.has(id) ? MINUTE
            : rank < 50 || (state?.rate || 0) >= 10 ? 5 * MINUTE : 60 * MINUTE;
          if (!state || this.now() - state.at >= interval) due.add(id);
        }
      }
      const ids = [...due];
      const videos = [];
      for (let i = 0; i < ids.length; i += 50) {
        videos.push(...await this.api('videos', { part: 'snippet,statistics', id: ids.slice(i, i + 50).join(',') }));
      }
      const updates = new Map();
      for (const id of ids) updates.set(id, { at: Math.floor(this.now() / MINUTE) * MINUTE, count: null, rate: 0, excluded: true });
      for (const video of videos) {
        const count = validCount(video.statistics?.viewCount);
        const previous = this.videoState.get(video.id);
        const elapsed = previous ? (this.now() - previous.at) / MINUTE : 0;
        const rate = elapsed > 0 && count !== null && previous.count !== null ? Math.max(0, (count - previous.count) / elapsed) : 0;
        updates.set(video.id, { at: Math.floor(this.now() / MINUTE) * MINUTE, count, rate: previous ? 0.5 * rate + 0.5 * previous.rate : rate,
          excluded: video.snippet?.liveBroadcastContent !== 'none' });
      }
      const metadata = {};
      const sample = { at: Math.floor(this.now() / MINUTE) * MINUTE, channels: [] };
      for (const channel of channels) {
        if (!this.channelIds.includes(channel.id)) continue;
        // videos.list response order is not a chronology guarantee; preserve playlist order.
        const byId = new Map(videos.map((video) => [video.id, video]));
        const recent = (idsByChannel.get(channel.id) || []).map((id) => byId.get(id)).filter((video) =>
          video?.snippet?.channelId === channel.id && video.snippet?.liveBroadcastContent === 'none').slice(0, 100);
        const views = {};
        metadata[channel.id] = { title: channel.snippet?.title || '', videos: {} };
        for (const video of recent) {
          const count = validCount(video.statistics?.viewCount);
          if (count === null) continue;
          views[video.id] = count;
          metadata[channel.id].videos[video.id] = { title: video.snippet?.title || '', publishedAt: video.snippet?.publishedAt || null };
        }
        sample.channels.push({ id: channel.id, subscriberCount: channel.statistics?.hiddenSubscriberCount ? null : validCount(channel.statistics?.subscriberCount), views });
      }
      if (!sample.channels.length) throw new Error('No channel data');
      await this.store.save(sample, metadata);
      for (const [id, state] of updates) this.videoState.set(id, state);
      this.lastSuccessAt = new Date(this.now()).toISOString();
      this.lastError = null;
      return true;
    } catch (error) {
      // Never log request URLs, keys or upstream response bodies.
      this.lastError = /^(YouTube HTTP|Storage HTTP) \d+$/.test(error.message) ? error.message : 'Collection failed';
      return false;
    } finally {
      this.running = false;
    }
  }
}

function validCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

module.exports = { Collector, RedisStore, MINUTE, RETENTION_MS, validCount };
