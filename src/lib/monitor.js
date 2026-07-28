'use strict';

const { fetchChannelSnapshot } = require('./youtube');
const { eventDedupKey } = require('./events');

const OFFICIAL_STATS_INTERVAL_MS = 10 * 60 * 1000;
const HISTORY_HEARTBEAT_MS = 6 * 60 * 60 * 1000;
const HISTORY_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

class ChannelMonitor {
  constructor({ store, onState, onNotify, onOpen }) {
    this.store = store;
    this.onState = onState;
    this.onNotify = onNotify;
    this.onOpen = onOpen;
    this.runtime = new Map();
    this.officialCache = new Map();
    this.officialCheckedAt = new Map();
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.nextCheckAt = null;
  }

  start() {
    this.stopped = false;
    this.#schedule(250);
  }

  stop() {
    this.stopped = true;
    this.nextCheckAt = null;
    clearTimeout(this.timer);
    this.timer = null;
  }

  restart() {
    this.stop();
    this.start();
  }

  async runNow({ forceOfficial = false } = {}) {
    if (this.running) return this.publicState();
    clearTimeout(this.timer);
    this.running = true;
    this.nextCheckAt = null;
    this.#emit();

    const channels = [...this.store.data.channels];
    await Promise.all(channels.map((channel) => this.#checkChannel(channel, forceOfficial)));

    this.running = false;
    this.#emit();
    if (!this.stopped) this.#schedule(this.#pollIntervalMs());
    return this.publicState();
  }

  publicState() {
    const settings = this.store.data.settings;
    return {
      settings: {
        ...settings,
        apiKey: undefined,
        hasApiKey: Boolean(settings.apiKey)
      },
      channels: this.store.data.channels.map((channel) => ({
        ...channel,
        ...(this.runtime.get(channel.id) || {
          status: 'waiting',
          snapshot: null,
          error: null
        })
      })),
      events: this.store.data.events,
      monitor: {
        running: this.running,
        nextCheckAt: this.nextCheckAt,
        pollIntervalSeconds: settings.pollIntervalSeconds
      }
    };
  }

  #schedule(delay) {
    clearTimeout(this.timer);
    this.nextCheckAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => this.runNow(), delay);
    this.#emit();
  }

  async #checkChannel(channel, forceOfficial) {
    const now = Date.now();
    const lastOfficial = this.officialCheckedAt.get(channel.id) || 0;
    const includeOfficialStats = Boolean(this.store.data.settings.apiKey)
      && (forceOfficial || now - lastOfficial >= OFFICIAL_STATS_INTERVAL_MS);

    this.runtime.set(channel.id, {
      ...(this.runtime.get(channel.id) || {}),
      status: 'checking',
      error: null
    });
    this.#emit();

    try {
      const snapshot = await fetchChannelSnapshot(channel, {
        apiKey: this.store.data.settings.apiKey,
        includeOfficialStats
      });
      if (snapshot.metadata?.source === 'api') {
        this.officialCache.set(channel.id, snapshot.metadata);
        this.officialCheckedAt.set(channel.id, now);
      } else if (this.officialCache.has(channel.id)) {
        snapshot.metadata = {
          ...snapshot.metadata,
          ...this.officialCache.get(channel.id)
        };
      }
      if (includeOfficialStats) this.officialCheckedAt.set(channel.id, now);

      this.#processChanges(channel, snapshot);
      this.runtime.set(channel.id, {
        status: snapshot.warnings.length ? 'degraded' : 'online',
        snapshot,
        error: null
      });
    } catch (error) {
      const message = friendlyError(error);
      this.runtime.set(channel.id, {
        ...(this.runtime.get(channel.id) || {}),
        status: 'error',
        error: message,
        checkedAt: new Date().toISOString()
      });
      this.#addEvent({
        channelId: channel.id,
        type: 'error',
        title: `${channel.title || '채널'} 확인 실패`,
        detail: message
      });
    }
    this.#emit();
  }

  #processChanges(channel, snapshot) {
    const settings = this.store.data.settings;
    const latestVideo = snapshot.latestVideo;
    const latestPost = snapshot.latestPost;
    const recentVideos = uniqueContentItems(snapshot.recentVideos || [latestVideo]);
    const recentPosts = uniqueContentItems(snapshot.recentPosts || [latestPost]);
    const videoTrackingInitialized = Array.isArray(channel.seenVideoIds);
    const postTrackingInitialized = Array.isArray(channel.seenPostIds);
    const seenVideoIds = new Set(videoTrackingInitialized ? channel.seenVideoIds : []);
    const seenPostIds = new Set(postTrackingInitialized ? channel.seenPostIds : []);
    const newVideos = findUnseenItems(recentVideos, seenVideoIds, videoTrackingInitialized);
    const newPosts = findUnseenItems(recentPosts, seenPostIds, postTrackingInitialized);

    for (const video of [...newVideos].reverse()) {
      this.#addEvent({
        channelId: channel.id,
        type: 'video',
        sourceId: video.id,
        title: '새 동영상',
        detail: video.title,
        url: video.url
      });
      if (settings.notifyNewVideos) {
        this.onNotify({
          title: `${snapshot.metadata.title} · 새 동영상`,
          body: video.title,
          url: video.url
        });
      }
    }

    for (const post of [...newPosts].reverse()) {
      this.#addEvent({
        channelId: channel.id,
        type: 'post',
        sourceId: post.id,
        title: '새 게시물',
        detail: post.text,
        url: post.url
      });
      if (settings.notifyNewPosts) {
        this.onNotify({
          title: `${snapshot.metadata.title} · 새 게시물`,
          body: post.text.slice(0, 160),
          url: post.url
        });
      }
    }

    for (const video of recentVideos) seenVideoIds.add(video.id);
    for (const post of recentPosts) seenPostIds.add(post.id);

    const opened = new Set(channel.openedBroadcastIds || []);
    if (snapshot.live?.id) {
      const liveKey = `live:${snapshot.live.id}`;
      if (settings.autoOpenLive && !opened.has(liveKey)) {
        this.#addEvent({
          channelId: channel.id,
          type: 'live',
          sourceId: snapshot.live.id,
          title: '라이브 시작',
          detail: snapshot.live.title,
          url: snapshot.live.url
        });
        this.onNotify({
          title: `${snapshot.metadata.title} · LIVE`,
          body: snapshot.live.title,
          url: snapshot.live.url
        });
        this.onOpen(snapshot.live.url);
        opened.add(liveKey);
      }
    }

    for (const upcoming of snapshot.upcoming || []) {
      const upcomingKey = `upcoming:${upcoming.id}`;
      if (settings.autoOpenUpcoming && !opened.has(upcomingKey)) {
        this.#addEvent({
          channelId: channel.id,
          type: 'upcoming',
          sourceId: upcoming.id,
          title: '예약 방송 발견',
          detail: upcoming.title,
          url: upcoming.url
        });
        this.onNotify({
          title: `${snapshot.metadata.title} · 예약 방송`,
          body: upcoming.title,
          url: upcoming.url
        });
        this.onOpen(upcoming.url);
        opened.add(upcomingKey);
      }
    }

    this.store.update((data) => {
      const stored = data.channels.find((item) => item.id === channel.id);
      if (!stored) return;
      stored.title = snapshot.metadata.title || stored.title;
      stored.avatarUrl = snapshot.metadata.avatarUrl || stored.avatarUrl;
      stored.lastCheckedAt = snapshot.checkedAt;
      if (latestVideo?.id) stored.lastVideoId = latestVideo.id;
      if (latestPost?.id) stored.lastPostId = latestPost.id;
      stored.seenVideoIds = [...seenVideoIds].slice(-100);
      stored.seenPostIds = [...seenPostIds].slice(-100);
      stored.openedBroadcastIds = [...opened].slice(-100);
      this.#recordSubscriberSample(stored, snapshot.metadata.subscriberCount, snapshot.checkedAt);
    });
  }

  #recordSubscriberSample(channel, count, checkedAt) {
    if (!Number.isFinite(count)) return;
    const history = Array.isArray(channel.subscriberHistory) ? channel.subscriberHistory : [];
    const last = history.at(-1);
    const sampleTime = new Date(checkedAt).getTime();
    const lastTime = last ? new Date(last.at).getTime() : 0;
    if (!last || last.count !== count || sampleTime - lastTime >= HISTORY_HEARTBEAT_MS) {
      history.push({ at: checkedAt, count });
    }
    const cutoff = sampleTime - HISTORY_RETENTION_MS;
    channel.subscriberHistory = history
      .filter((sample) => new Date(sample.at).getTime() >= cutoff)
      .slice(-500);
  }

  #addEvent(event) {
    this.store.update((data) => {
      const key = eventDedupKey(event);
      if (key && (data.events || []).some((existing) => eventDedupKey(existing) === key)) {
        return;
      }
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        ...event
      };
      data.events = [entry, ...(data.events || [])].slice(0, 100);
    });
  }

  #pollIntervalMs() {
    return this.store.data.settings.pollIntervalSeconds * 1000;
  }

  #emit() {
    this.onState(this.publicState());
  }
}

function uniqueContentItems(items) {
  const seen = new Set();
  return (items || []).filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function findUnseenItems(items, seenIds, initialized = true) {
  if (!initialized) return [];
  const seen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
  return uniqueContentItems(items).filter((item) => !seen.has(item.id));
}

function friendlyError(error) {
  if (error?.name === 'TimeoutError') return '응답 시간이 초과되었습니다.';
  if (error?.status === 429) return 'YouTube 요청 한도에 도달했습니다. 잠시 후 다시 시도합니다.';
  if (error?.status === 403) return '접근이 거부되었습니다. API 키 또는 네트워크 설정을 확인하세요.';
  return error?.message || '알 수 없는 오류';
}

module.exports = {
  ChannelMonitor,
  findUnseenItems,
  friendlyError,
  uniqueContentItems
};
