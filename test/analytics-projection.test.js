'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {projectChannel, validateScope} = require('../src/lib/analytics-projection');
const {withCloudHistory} = require('../src/lib/cloud-sync');
const id = 'UCtKtCiaWRz-d3EZn2xd1mdA';
const samples = Array.from({length: 2500}, (_,i) => ({at: new Date(Date.now() - (2501-i)*60000).toISOString(), count: 1000+i}));
const channel = {id, subscriberHistory: samples.slice(0,3), videoViewHistories: []};
const cloud = {channels: {[id]: {subscriberHistory: samples, videoViewHistories: [
  {videoId:'mFM2hP5LEhM',title:'A',samples}, {videoId:'WTdyA5N4K0k',title:'B',samples}
]}}};
test('overview retains endpoints without transferring per-video archives or mutating storage', () => {
  const original = JSON.stringify(cloud);
  const result = projectChannel(channel, cloud);
  assert.equal(result.videoViewHistories.length,2);
  assert.ok(result.subscriberHistory.length <= 120);
  for (const v of result.videoViewHistories) assert.deepEqual(v.samples,[samples[0],samples.at(-1)]);
  assert.equal(JSON.stringify(cloud),original);
});
test('selected video and subscriber projections match original full projection', () => {
  const full = withCloudHistory(channel,cloud);
  const selected = projectChannel(channel,cloud,{subscriberId:id,videos:[{channelId:id,videoId:'mFM2hP5LEhM'}]});
  assert.deepEqual(selected.subscriberHistory,full.subscriberHistory);
  assert.deepEqual(selected.videoViewHistories.find(v=>v.videoId==='mFM2hP5LEhM'),full.videoViewHistories.find(v=>v.videoId==='mFM2hP5LEhM'));
  assert.equal(selected.videoViewHistories.find(v=>v.videoId==='WTdyA5N4K0k').samples.length,2);
  assert.ok(selected.videoViewHistories[0].samples.length <= 2000);
});
test('analytics request is limited to registered channels and four valid videos', () => {
  assert.deepEqual(validateScope({subscriberId:null,videos:[]},[channel]),{subscriberId:null,videos:[]});
  assert.throws(()=>validateScope({subscriberId:'unknown',videos:[]},[channel]));
  assert.throws(()=>validateScope({subscriberId:null,videos:Array(5).fill({channelId:id,videoId:'mFM2hP5LEhM'})},[channel]));
  assert.throws(()=>validateScope({subscriberId:null,videos:[{channelId:id,videoId:'../../foo'}]},[channel]));
});
