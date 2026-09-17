'use strict';

const TARGET_CHANNEL_ID = 'UCtKtCiaWRz-d3EZn2xd1mdA';

const DEFAULT_SETTINGS = Object.freeze({
  pollIntervalSeconds: 30,
  startAtLogin: true,
  autoOpenLive: true,
  autoOpenUpcoming: true,
  notifyNewVideos: true,
  notifyNewPosts: true,
  subscriberChartMode: 'samples',
  apiKey: '',
  cloudUrl: '',
  cloudToken: ''
});

function createDefaultChannel() {
  return {
    id: TARGET_CHANNEL_ID,
    inputUrl: `https://www.youtube.com/channel/${TARGET_CHANNEL_ID}`,
    title: '채널 정보 불러오는 중',
    avatarUrl: '',
    addedAt: new Date().toISOString(),
    lastVideoId: null,
    lastPostId: null,
    openedBroadcastIds: [],
    subscriberHistory: [],
    videoViewHistories: []
  };
}

function createDefaultData() {
  return {
    version: 3,
    settings: { ...DEFAULT_SETTINGS },
    channels: [createDefaultChannel()],
    events: []
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  TARGET_CHANNEL_ID,
  createDefaultChannel,
  createDefaultData
};
