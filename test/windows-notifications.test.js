'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  APP_USER_MODEL_ID,
  TOAST_ACTIVATOR_CLSID,
  buildStartMenuShortcutPath,
  configureWindowsNotificationIdentity,
  sameWindowsPath
} = require('../src/lib/windows-notifications');

function createHarness({ isPackaged = true, target = 'C:\\Apps\\Live Pulse\\라이브 펄스.exe' } = {}) {
  const calls = [];
  const app = {
    isPackaged,
    setAppUserModelId(value) {
      calls.push(['appUserModelId', value]);
    },
    setToastActivatorCLSID(value) {
      calls.push(['toastActivatorClsid', value]);
    }
  };
  const shell = {
    readShortcutLink(shortcutPath) {
      calls.push(['read', shortcutPath]);
      return { target, description: '라이브 펄스' };
    },
    writeShortcutLink(shortcutPath, operation, details) {
      calls.push(['write', shortcutPath, operation, details]);
      return true;
    }
  };
  return { app, shell, calls };
}

test('시작 메뉴 알림 바로가기 경로를 사용자 AppData 아래에서 만든다', () => {
  const appDataPath = 'C:\\Users\\tester\\AppData\\Roaming';
  assert.equal(
    buildStartMenuShortcutPath(appDataPath),
    path.join(appDataPath, 'Microsoft', 'Windows', 'Start Menu', 'Programs', '라이브 펄스.lnk')
  );
  assert.equal(buildStartMenuShortcutPath(''), null);
});

test('Windows 실행 파일 경로는 대소문자 차이를 무시해 비교한다', () => {
  assert.equal(
    sameWindowsPath('C:\\Apps\\LIVE PULSE\\라이브 펄스.exe', 'c:\\apps\\live pulse\\라이브 펄스.exe'),
    true
  );
  assert.equal(sameWindowsPath('C:\\Apps\\one.exe', 'C:\\Apps\\two.exe'), false);
});

test('설치본은 고정 알림 식별자를 설정하고 시작 메뉴 바로가기를 복구한다', () => {
  const execPath = 'C:\\Apps\\Live Pulse\\라이브 펄스.exe';
  const appDataPath = 'C:\\Users\\tester\\AppData\\Roaming';
  const harness = createHarness({ target: 'c:\\apps\\live pulse\\라이브 펄스.exe' });
  const result = configureWindowsNotificationIdentity({
    ...harness,
    platform: 'win32',
    execPath,
    appDataPath
  });

  assert.equal(result.mode, 'production');
  assert.equal(result.shortcutUpdated, true);
  assert.deepEqual(harness.calls[1], ['appUserModelId', APP_USER_MODEL_ID]);
  assert.deepEqual(harness.calls[2], ['toastActivatorClsid', TOAST_ACTIVATOR_CLSID]);
  assert.equal(harness.calls[3][0], 'write');
  assert.equal(harness.calls[3][2], 'update');
  assert.deepEqual(harness.calls[3][3], {
    target: 'c:\\apps\\live pulse\\라이브 펄스.exe',
    appUserModelId: APP_USER_MODEL_ID,
    toastActivatorClsid: TOAST_ACTIVATOR_CLSID
  });
});

test('개발 실행은 production 알림 등록을 덮어쓰지 않도록 electron.exe 경로를 쓴다', () => {
  const execPath = 'C:\\project\\node_modules\\electron\\dist\\electron.exe';
  const harness = createHarness({ isPackaged: false });
  const result = configureWindowsNotificationIdentity({
    ...harness,
    platform: 'win32',
    execPath,
    appDataPath: 'C:\\Users\\tester\\AppData\\Roaming'
  });

  assert.equal(result.mode, 'development');
  assert.deepEqual(harness.calls, [['appUserModelId', execPath]]);
});

test('스모크 실행과 설치 경로가 아닌 압축 해제본도 production 알림 등록을 건드리지 않는다', () => {
  const execPath = 'C:\\workspace\\dist\\win-unpacked\\라이브 펄스.exe';
  for (const isSmokeTest of [true, false]) {
    const harness = createHarness({ target: 'C:\\Users\\tester\\AppData\\Local\\라이브 펄스.exe' });
    const result = configureWindowsNotificationIdentity({
      ...harness,
      isSmokeTest,
      platform: 'win32',
      execPath,
      appDataPath: 'C:\\Users\\tester\\AppData\\Roaming'
    });

    assert.equal(result.mode, 'development');
    assert.deepEqual(harness.calls.at(-1), ['appUserModelId', execPath]);
    assert.equal(harness.calls.some((call) => call[0] === 'write'), false);
  }
});

test('바로가기 갱신 실패는 앱 시작을 막지 않고 경고로 남긴다', () => {
  const execPath = 'C:\\Apps\\Live Pulse\\라이브 펄스.exe';
  const harness = createHarness({ target: execPath });
  harness.shell.writeShortcutLink = () => {
    throw new Error('access denied');
  };
  const result = configureWindowsNotificationIdentity({
    ...harness,
    platform: 'win32',
    execPath,
    appDataPath: 'C:\\Users\\tester\\AppData\\Roaming'
  });

  assert.equal(result.mode, 'production');
  assert.equal(result.shortcutUpdated, false);
  assert.match(result.warning, /access denied/);
});
