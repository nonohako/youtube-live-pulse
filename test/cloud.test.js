'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { Collector, RedisStore, RETENTION_MS, validCount } = require('../cloud/collector');
const { createServer } = require('../cloud/server');
const { CloudSync, mergePage, withCloudHistory, normalizeCloudUrl, pruneCloud } = require('../src/lib/cloud-sync');
const { ChannelMonitor } = require('../src/lib/monitor');
const CID = 'UCtKtCiaWRz-d3EZn2xd1mdA';
const VID = 'mFM2hP5LEhM';
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
test('연결 파일은 주소와 읽기 키만 가져오고 다른 설정을 무시한다', () => {
  const { parseConnectionFile } = require('../src/lib/cloud-sync');
  const config = { cloudUrl: 'https://pulse.fly.dev', cloudToken: 'a'.repeat(64) };
  assert.deepEqual(parseConnectionFile(JSON.stringify({ ...config, apiKey: 'must not import', autoOpenLive: false })), config);
  assert.throws(() => parseConnectionFile(JSON.stringify({ ...config, cloudUrl: 'http://evil.example' })));
  assert.throws(() => parseConnectionFile('x'.repeat(4097)));
});
const makePage = (at = NOW) => ({ version: 1, next: at, hasMore: false,
  metadata: { [CID]: { videos: { [VID]: { title: '쇼츠' } } } },
  samples: [{ at, channels: [{ id: CID, subscriberCount: 100000, views: { [VID]: 1234 } }] }],
  status: { lastSuccessAt: new Date(NOW).toISOString(), error: null }
});

test('공식 API는 통계를 묶어 조회하고 비공개 수를 0으로 만들지 않는다', async () => {
  const paths = [];
  let saved;
  const collector = new Collector({ channelIds: [CID], apiKey: 'test', now: () => NOW,
    store: { save: async (sample) => { saved = sample; } },
    fetcher: async (url) => {
      paths.push(url.pathname);
      const items = url.pathname.endsWith('/channels')
        ? [{ id: CID, snippet: { title: '채널' }, statistics: { hiddenSubscriberCount: true }, contentDetails: { relatedPlaylists: { uploads: 'UUtest' } } }]
        : url.pathname.endsWith('/playlistItems') ? [{ contentDetails: { videoId: VID } }, { contentDetails: { videoId: 'abcdefghijk' } }]
          : [{ id: VID, snippet: { channelId: CID, title: '쇼츠', liveBroadcastContent: 'none' }, statistics: { viewCount: '1234' } },
            { id: 'abcdefghijk', snippet: { channelId: CID, liveBroadcastContent: 'live' }, statistics: { viewCount: '999' } }];
      return { ok: true, json: async () => ({ items }) };
    }
  });
  assert.equal(await collector.collect(), true);
  assert.equal(saved.channels[0].subscriberCount, null);
  assert.deepEqual(saved.channels[0].views, { [VID]: 1234 });
  await collector.collect();
  assert.equal(paths.filter((path) => path.endsWith('/playlistItems')).length, 1);
  assert.equal(paths.filter((path) => path.endsWith('/videos')).length, 1);
  assert.equal(validCount(null), null);
  assert.equal(validCount('0'), 0);
});

test('수집 실패는 성공 시각이나 기록을 조작하지 않고 다음 주기에 회복한다', async () => {
  let saves = 0;
  const collector = new Collector({ channelIds: [CID], apiKey: 'secret', store: { save: async () => { saves++; } }, fetcher: async () => { throw new Error('secret in URL'); } });
  assert.equal(await collector.collect(), false);
  assert.equal(collector.lastSuccessAt, null);
  assert.equal(collector.lastError.includes('secret'), false);
  assert.equal(collector.running, false);
  assert.equal(saves, 0);
});

test('Redis 명령 실패를 검출하며 읽기에서 30일 만료와 페이지 크기를 적용한다', async () => {
  const calls = [];
  const store = new RedisStore('https://example.upstash.io', 'secret', async (_url, options) => {
    const commands = JSON.parse(options.body); calls.push(commands);
    return { ok: true, json: async () => commands.map(([cmd]) => ({ result: cmd === 'ZRANGEBYSCORE' ? [] : null })) };
  });
  await store.save({ at: NOW, channels: [] }, {});
  const page = await store.read(0, NOW);
  assert.equal(page.next, 0);
  const read = calls.at(-1)[0];
  assert.equal(read[2], `(${NOW - RETENTION_MS}`);
  assert.equal(read.at(-1), 240);
  assert.ok(calls.flat().some((cmd) => cmd[0] === 'EXPIRE'));
  const broken = new RedisStore('https://example.upstash.io', 'secret', async () => ({ ok: true, json: async () => [{ error: 'quota' }] }));
  await assert.rejects(() => broken.read(0), /Storage command failed/);
});

test('클라우드 동기화는 채널을 구분하고 기존 로컬 기록을 보존한다', () => {
  const local = { id: CID, subscriberHistory: [{ at: new Date(NOW - 40 * 86400_000).toISOString(), count: 90000 }], videoViewHistories: [] };
  const before = JSON.stringify(local);
  const cloud = mergePage({}, makePage(), [CID], NOW);
  const displayed = withCloudHistory(local, cloud);
  assert.equal(displayed.subscriberHistory.length, 2);
  assert.equal(displayed.videoViewHistories[0].samples[0].count, 1234);
  assert.equal(JSON.stringify(local), before);
  assert.deepEqual(mergePage({}, makePage(), [], NOW).channels, {});
  assert.equal(pruneCloud(cloud, NOW + RETENTION_MS + 1).channels[CID].subscriberHistory.length, 1);
  assert.deepEqual(pruneCloud(null).channels, {});
});

test('재시작 커서와 페이지 재처리에서 중복을 만들지 않고 미래 기록을 거부한다', () => {
  const first = mergePage({}, makePage(NOW - 60_000), [CID], NOW);
  const second = mergePage(JSON.parse(JSON.stringify(first)), makePage(NOW), [CID], NOW);
  assert.equal(second.channels[CID].subscriberHistory.length, 2);
  const replay = mergePage({ ...second, cursor: 0 }, { ...makePage(), samples: [...makePage(NOW - 60_000).samples, ...makePage().samples] }, [CID], NOW);
  assert.equal(replay.channels[CID].subscriberHistory.length, 2);
  assert.throws(() => mergePage(second, makePage(NOW + 60_000), [CID], NOW));
  assert.throws(() => mergePage({}, { ...makePage(), next: NOW + 1 }, [CID], NOW));
});

test('연결 주소는 Fly HTTPS로 제한하고 읽기 키를 renderer 상태에서 숨긴다', () => {
  assert.equal(normalizeCloudUrl('https://pulse-test.fly.dev'), 'https://pulse-test.fly.dev');
  for (const url of ['http://pulse.fly.dev', 'https://evil.com', 'https://pulse.fly.dev@evil.com', 'https://pulse.fly.dev/path', 'https://pulse.fly.dev?key=x']) assert.throws(() => normalizeCloudUrl(url));
  const monitor = new ChannelMonitor({ store: { data: { settings: { cloudToken: 'secret', apiKey: 'secret', pollIntervalSeconds: 30 }, channels: [], events: [] } } });
  assert.equal(JSON.stringify(monitor.publicState()).includes('secret'), false);
});

test('2,000개를 넘는 구독자 샘플도 일별 마지막 값을 손실하지 않는다', () => {
  const samples = Array.from({ length: 3000 }, (_, i) => ({ at: new Date(NOW - (3000 - i) * 60_000).toISOString(), count: i }));
  const cloud = pruneCloud({ channels: { [CID]: { subscriberHistory: samples, videoViewHistories: [] } } }, NOW);
  const merged = withCloudHistory({ id: CID, subscriberHistory: [], videoViewHistories: [] }, cloud);
  assert.deepEqual(merged.subscriberHistory, samples);
});

test('동기화 실패 후 재시도는 저장한 커서에서 재개한다', async () => {
  let fail = true;
  const store = { data: { settings: { cloudUrl: 'https://pulse-test.fly.dev', cloudToken: 't'.repeat(32) }, channels: [{ id: CID }] }, update(fn) { fn(this.data); } };
  const sync = new CloudSync({ store, onState() {}, fetcher: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    if (fail) throw new Error('offline');
    return { ok: true, text: async () => JSON.stringify(makePage()) };
  } });
  await sync.sync();
  assert.ok(store.data.cloud.error);
  assert.equal(store.data.cloud.cursor, undefined);
  fail = false;
  await sync.sync();
  assert.equal(store.data.cloud.cursor, NOW);
  assert.equal(store.data.cloud.error, null);
});

test('HTTP 동기화 API는 인증, 커서 검증과 저장소 장애 응답을 제공한다', async (t) => {
  let reads = 0;
  const token = 'r'.repeat(32);
  const server = createServer({ readToken: token, collector: {}, store: { read: async () => { reads++; return makePage(); } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.equal((await fetch(`${url}/v1/sync`)).status, 401);
  assert.equal(reads, 0);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${url}/v1/sync?after=-1`, { headers })).status, 400);
  assert.equal((await fetch(`${url}/v1/sync`, { headers })).status, 200);
  assert.equal(reads, 1);
});

test('100 videos paginate discovery, use variable intervals and promote rising videos', async () => {
  let now = NOW + 1500, saved, lastIds = [];
  const ids = Array.from({length: 120}, (_, i) => String(i).padStart(11, '0'));
  const collector = new Collector({channelIds: [CID], apiKey: 'test', now: () => now,
    store: {save: async sample => { saved = sample; }},
    fetcher: async url => {
      let data;
      if (url.pathname.endsWith('/channels')) data = {items: [{id: CID, statistics: {subscriberCount: '100'}, contentDetails: {relatedPlaylists: {uploads: 'uploads'}}}]};
      else if (url.pathname.endsWith('/playlistItems')) {
        const start = Number(url.searchParams.get('pageToken') || 0);
        data = {items: ids.slice(start, start + 50).map(videoId => ({contentDetails: {videoId}})), ...(start + 50 < ids.length ? {nextPageToken: String(start + 50)} : {})};
      } else {
        lastIds.push(...url.searchParams.get('id').split(','));
        data = {items: url.searchParams.get('id').split(',').map(id => ({id, snippet: {channelId: CID, liveBroadcastContent: 'none'}, statistics: {viewCount: String(id === ids[80] && now >= NOW + 60 * 60000 ? 100000 : 100)}}))};
      }
      return {ok: true, json: async () => data};
    }});
  assert.equal(await collector.collect(), true);
  assert.equal(Object.keys(saved.channels[0].views).length, 100);
  now = NOW + 60000; lastIds = [];
  await collector.collect(); assert.equal(lastIds.length, 25);
  now = NOW + 5 * 60000; lastIds = [];
  await collector.collect(); assert.equal(lastIds.length, 50);
  now = NOW + 60 * 60000; lastIds = [];
  await collector.collect(); assert.equal(lastIds.length, 100);
  now += 60000; lastIds = [];
  await collector.collect();
  assert.ok(lastIds.includes(ids[80])); assert.equal(lastIds.length, 25);
});

test('downloaded archives preserve old samples and rotated videos without expiry or compaction', () => {
  const old = NOW - 500 * 86400000;
  const samples = Array.from({length: 2100}, (_, i) => ({at: new Date(old + i * 60000).toISOString(), count: i}));
  const histories = Array.from({length: 105}, (_, i) => ({videoId: String(i).padStart(11, '0'), samples}));
  const archive = pruneCloud({channels: {[CID]: {subscriberHistory: samples, videoViewHistories: histories}}}, NOW);
  assert.equal(archive.channels[CID].subscriberHistory.length, 2100);
  assert.equal(archive.channels[CID].videoViewHistories.length, 105);
  assert.equal(archive.channels[CID].videoViewHistories[0].samples.length, 2100);
  const views = Object.fromEntries(histories.slice(0,100).map(v => [v.videoId, 9999]));
  const page = makePage(); page.samples[0].channels[0].views = views;
  const merged = mergePage(archive, page, [CID], NOW);
  assert.equal(merged.channels[CID].videoViewHistories.filter(v => v.samples.at(-1).count === 9999).length, 100);
  assert.equal(merged.channels[CID].videoViewHistories.length, 105);
});

test('Redis caches metadata and stays within the one-desktop free command budget', async () => {
  let commands = 0, gets = 0, sets = 0;
  const store = new RedisStore('https://example.upstash.io', 'secret', async (_url, options) => {
    const batch = JSON.parse(options.body);
    commands += batch.length;
    gets += batch.filter(c => c[0] === 'GET').length;
    sets += batch.filter(c => c[0] === 'SET').length;
    return {ok: true, json: async () => batch.map(c => ({result: c[0] === 'ZRANGEBYSCORE' ? [] : null}))};
  });
  for (let minute = 0; minute < 60; minute++) {
    await store.save({at: NOW + minute * 60000, channels: []}, {[CID]: {title: 'Channel', videos: {[VID]: {title: 'Video'}}}});
    await store.read(0, NOW + minute * 60000);
  }
  assert.equal(gets, 1);
  assert.equal(sets, 12);
  assert.equal(commands, 313);
  assert.ok((commands - 1) * 24 * 31 < 250000);
  const restarted = new RedisStore('https://example.upstash.io', 'secret', async (_url, options) => ({ok: true, json: async () => JSON.parse(options.body).map(c => ({result: c[0] === 'GET' ? JSON.stringify(store.metadataCache) : []}))}));
  assert.equal((await restarted.read(0)).metadata[CID].videos[VID].title, 'Video');
});
