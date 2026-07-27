'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore, clampInterval } = require('../src/lib/store');
const { TARGET_CHANNEL_ID } = require('../src/lib/defaults');

test('첫 실행 시 기본 채널과 설정을 만든다', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-pulse-store-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'settings.json');
  const store = new JsonStore(filePath);
  const data = store.load();

  assert.equal(data.channels[0].id, TARGET_CHANNEL_ID);
  assert.equal(data.settings.pollIntervalSeconds, 30);
  assert.equal(data.settings.startAtLogin, true);
  assert.equal(fs.existsSync(filePath), true);
});

test('확인 주기를 15~300초 범위로 제한한다', () => {
  assert.equal(clampInterval(2), 15);
  assert.equal(clampInterval(45.4), 45);
  assert.equal(clampInterval(999), 300);
  assert.equal(clampInterval('invalid'), 30);
});
