'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore, clampInterval, normalizeSubscriberChartMode } = require('../src/lib/store');
const { TARGET_CHANNEL_ID } = require('../src/lib/defaults');

function temporaryStore(context, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-pulse-recovery-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new JsonStore(path.join(directory, 'live-pulse.json'), options);
}

test('zero-filled primary recovers channels and histories from a normal backup', context => {
  const store = temporaryStore(context); store.load();
  store.data.channels.push({id:'UCWpY0eSJtyO-qNAPbKFRSSg',subscriberHistory:[{at:'2026-09-17T13:00:00Z',count:123}]});
  store.lastBackupAt=0; store.save();
  const damaged=Buffer.alloc(4096); fs.writeFileSync(store.filePath,damaged);
  const recovered=new JsonStore(store.filePath); const data=recovered.load();
  assert.equal(data.channels.length,2);
  assert.equal(data.channels[1].subscriberHistory[0].count,123);
  assert.equal(recovered.recovery.source,'live-pulse.json.bak');
  const broken=fs.readdirSync(path.dirname(store.filePath)).find(n=>n.includes('.broken-'));
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(store.filePath),broken)),damaged);
});

test('interrupted rename recovers a durable temporary file without default initialization', context => {
  const store=temporaryStore(context); store.load();
  store.data.channels[0].title='recovered temporary';
  fs.writeFileSync(store.filePath+'.tmp',JSON.stringify(store.data));
  fs.unlinkSync(store.filePath);
  const reopened=new JsonStore(store.filePath);
  assert.equal(reopened.load().channels[0].title,'recovered temporary');
  assert.equal(reopened.recovery.source,'live-pulse.json.tmp');
});

test('unrecoverable corruption never replaces originals with defaults, including later saves', context => {
  const store=temporaryStore(context);
  fs.writeFileSync(store.filePath,Buffer.alloc(128));
  fs.writeFileSync(store.filePath+'.bak','broken backup');
  assert.throws(()=>store.load(),{code:'STORE_RECOVERY_REQUIRED'});
  assert.throws(()=>store.save());
  assert.deepEqual(fs.readFileSync(store.filePath),Buffer.alloc(128));
  assert.equal(fs.readFileSync(store.filePath+'.bak','utf8'),'broken backup');
});

test('permission errors do not trigger fallback or initialization', context => {
  const store=temporaryStore(context); store.load();
  const before=fs.readFileSync(store.filePath); const read=fs.readFileSync;
  context.mock.method(fs,'readFileSync',function(file,...args){if(file===store.filePath)throw Object.assign(new Error('denied'),{code:'EACCES'});return read.call(this,file,...args);});
  assert.throws(()=>store.load(),{code:'EACCES'});
  assert.throws(()=>store.save());
  assert.deepEqual(read(store.filePath),before);
});

test('failed disk flush leaves the primary unchanged and a durable write flushes before rename', context => {
  const store=temporaryStore(context); store.load();
  const before=fs.readFileSync(store.filePath);
  store.data.channels[0].title='changed';
  context.mock.method(fs,'fsyncSync',()=>{throw Object.assign(new Error('disk failure'),{code:'EIO'});});
  assert.throws(()=>store.save(),{code:'EIO'});
  assert.deepEqual(fs.readFileSync(store.filePath),before);
  context.mock.restoreAll();
  const calls=[];const flush=fs.fsyncSync,rename=fs.renameSync;
  context.mock.method(fs,'fsyncSync',function(fd){calls.push('flush');return flush.call(this,fd);});
  context.mock.method(fs,'renameSync',function(from,to){calls.push('rename');return rename.call(this,from,to);});
  store.save();assert.deepEqual(calls,['flush','rename']);
});

test('two backup generations survive damage to the primary and newest backup', context => {
  const store=temporaryStore(context,{backupIntervalMs:0});store.load();
  store.data.channels[0].title='older valid';store.save();
  store.data.channels[0].title='newer valid';store.save();
  fs.writeFileSync(store.filePath,'broken');fs.writeFileSync(store.filePath+'.bak','broken');
  const recovered=new JsonStore(store.filePath);
  assert.equal(recovered.load().channels[0].title,'older valid');
  assert.equal(recovered.recovery.source,'live-pulse.json.bak.1');
});

test('normalization failure and invalid document shape cannot silently reset the store', context => {
  const store=temporaryStore(context);store.load();
  const data=JSON.parse(fs.readFileSync(store.filePath));
  data.cloud={channels:{[TARGET_CHANNEL_ID]:null}};
  const raw=JSON.stringify(data);fs.writeFileSync(store.filePath,raw);
  assert.throws(()=>store.load(),TypeError);assert.throws(()=>store.save());
  assert.equal(fs.readFileSync(store.filePath,'utf8'),raw);
  fs.unlinkSync(store.filePath+'.bak');fs.writeFileSync(store.filePath,'{}');
  assert.throws(()=>store.load(),{code:'STORE_RECOVERY_REQUIRED'});
});

test('첫 실행 시 기본 채널과 설정을 만든다', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-pulse-store-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'settings.json');
  const store = new JsonStore(filePath);
  const data = store.load();

  assert.equal(data.channels[0].id, TARGET_CHANNEL_ID);
  assert.equal(data.settings.pollIntervalSeconds, 30);
  assert.equal(data.version, 3);
  assert.equal(data.settings.startAtLogin, true);
  assert.equal(data.settings.subscriberChartMode, 'samples');
  assert.equal(fs.existsSync(filePath), true);
});

test('구독자 차트 표시 기준은 허용된 날짜 기준만 보존한다', () => {
  assert.equal(normalizeSubscriberChartMode('daily'), 'daily');
  assert.equal(normalizeSubscriberChartMode('samples'), 'samples');
  assert.equal(normalizeSubscriberChartMode('invalid'), 'samples');
});

test('확인 주기를 15~300초 범위로 제한한다', () => {
  assert.equal(clampInterval(2), 15);
  assert.equal(clampInterval(45.4), 45);
  assert.equal(clampInterval(999), 300);
  assert.equal(clampInterval('invalid'), 30);
});

test('기존 저장 파일을 열 때 중복 알림을 정리하고 영상 조회수 이력을 마이그레이션한다', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-pulse-store-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'settings.json');
  const duplicateUrl = 'https://www.youtube.com/watch?v=abcdefghijk';
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    settings: {},
    channels: [{ id: TARGET_CHANNEL_ID, videoViewHistories: [{
      videoId: 'abcdefghijk',
      samples: [{ at: '2026-08-11T00:00:00Z', count: 100 }]
    }] }],
    events: [
      { id: 'newer', channelId: TARGET_CHANNEL_ID, type: 'video', url: duplicateUrl },
      { id: 'older', channelId: TARGET_CHANNEL_ID, type: 'video', url: duplicateUrl }
    ]
  }), 'utf8');

  const data = new JsonStore(filePath).load();

  assert.equal(data.version, 3);
  assert.deepEqual(data.events.map((event) => event.id), ['newer']);
  assert.equal(data.channels[0].videoViewHistories[0].samples[0].count, 100);
});
