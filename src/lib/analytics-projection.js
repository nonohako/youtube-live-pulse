'use strict';
const { withCloudHistory } = require('./cloud-sync');
const { compactSamples } = require('./video-history');

function validateScope(value, channels) {
  if (!value || !Array.isArray(value.videos) || value.videos.length > 4) throw new Error('분석 요청이 올바르지 않습니다.');
  const ids = new Set(channels.map(c => c.id));
  if (value.subscriberId !== null && !ids.has(value.subscriberId)) throw new Error('채널을 찾을 수 없습니다.');
  const videos = value.videos.map(v => {
    if (!ids.has(v?.channelId) || !/^[\w-]{11}$/.test(v?.videoId || '')) throw new Error('영상을 찾을 수 없습니다.');
    return {channelId: v.channelId, videoId: v.videoId};
  });
  return {subscriberId: value.subscriberId, videos};
}

function edges(samples = []) { return samples.length > 1 ? [samples[0], samples.at(-1)] : samples; }
function mergeSmall(first = [], second = [], limit = 120) {
  const points = new Map();
  for (const s of [...first, ...second]) points.set(s.at, s);
  return compactSamples([...points.values()].sort((a,b) => Date.parse(a.at) - Date.parse(b.at)), limit);
}

// The archive is normalized by the store. Only inspect endpoints for list metadata.
function projectChannel(channel, cloud, scope = {subscriberId: null, videos: []}) {
  const extra = cloud?.channels?.[channel.id];
  const selected = new Set(scope.videos.filter(v => v.channelId === channel.id).map(v => v.videoId));
  const subscribers = scope.subscriberId === channel.id;
  const localVideos = channel.videoViewHistories || [], cloudVideos = extra?.videoViewHistories || [];
  const videos = new Map(cloudVideos.map(v => [v.videoId, {...v, samples: edges(v.samples)}]));
  for (const v of localVideos) {
    const previous = videos.get(v.videoId);
    videos.set(v.videoId, {...previous, ...v, samples: edges(mergeSmall(previous?.samples, edges(v.samples)))});
  }
  let subscriberHistory = mergeSmall(compactSamples(extra?.subscriberHistory || [], 120), compactSamples(channel.subscriberHistory || [], 120));
  if (subscribers || selected.size) {
    const detail = withCloudHistory({...channel,
      subscriberHistory: subscribers ? channel.subscriberHistory : [],
      videoViewHistories: localVideos.filter(v => selected.has(v.videoId))
    }, {channels: {[channel.id]: {
      subscriberHistory: subscribers ? extra?.subscriberHistory || [] : [],
      videoViewHistories: cloudVideos.filter(v => selected.has(v.videoId))
    }}});
    if (subscribers) subscriberHistory = detail.subscriberHistory;
    for (const v of detail.videoViewHistories) videos.set(v.videoId, v);
  }
  return {...channel, subscriberHistory, videoViewHistories: [...videos.values()].sort((a,b) => Date.parse(b.publishedAt || b.lastCheckedAt || 0) - Date.parse(a.publishedAt || a.lastCheckedAt || 0))};
}
module.exports = {projectChannel, validateScope};
