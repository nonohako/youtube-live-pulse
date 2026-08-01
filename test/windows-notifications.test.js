'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  APP_USER_MODEL_ID,
  TOAST_ACTIVATOR_CLSID,
  buildDefaultInstallExecutablePath,
  buildLegacyElectronShortcutPaths,
  buildStartMenuShortcutPath,
  buildWindowsTaskbarDetails,
  configureWindowsNotificationIdentity,
  quoteWindowsCommandArgument,
  repairOwnedLegacyElectronShortcuts,
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

test('기본 NSIS 설치 실행 파일 경로를 LocalAppData 아래에서 만든다', () => {
  const localAppDataPath = 'C:\\Users\\tester\\AppData\\Local';
  assert.equal(
    buildDefaultInstallExecutablePath(localAppDataPath),
    path.join(localAppDataPath, 'Programs', 'youtube-live-pulse', '라이브 펄스.exe')
  );
  assert.equal(buildDefaultInstallExecutablePath(''), null);
});

test('이전 Electron 바로가기는 시작 메뉴와 작업표시줄 고정 위치에서만 찾는다', () => {
  const appDataPath = 'C:\\Users\\tester\\AppData\\Roaming';
  assert.deepEqual(buildLegacyElectronShortcutPaths(appDataPath), [
    path.join(appDataPath, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Electron.lnk'),
    path.join(
      appDataPath,
      'Microsoft',
      'Internet Explorer',
      'Quick Launch',
      'User Pinned',
      'TaskBar',
      'Electron.lnk'
    )
  ]);
  assert.deepEqual(buildLegacyElectronShortcutPaths(''), []);
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
    target: 'C:\\Apps\\Live Pulse\\라이브 펄스.exe',
    icon: 'C:\\Apps\\Live Pulse\\라이브 펄스.exe',
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID,
    toastActivatorClsid: TOAST_ACTIVATOR_CLSID
  });
  assert.equal(result.shortcutTargetRepaired, false);
});

test('기본 설치 위치에서 실행하면 다른 사용자 경로로 남은 제품 바로가기를 복구한다', () => {
  const localAppDataPath = 'C:\\Users\\tester\\AppData\\Local';
  const execPath = buildDefaultInstallExecutablePath(localAppDataPath);
  const harness = createHarness({
    target: 'C:\\Users\\old-user\\AppData\\Local\\Programs\\youtube-live-pulse\\라이브 펄스.exe'
  });
  const result = configureWindowsNotificationIdentity({
    ...harness,
    platform: 'win32',
    execPath,
    appDataPath: 'C:\\Users\\tester\\AppData\\Roaming',
    localAppDataPath
  });

  assert.equal(result.mode, 'production');
  assert.equal(result.shortcutTargetRepaired, true);
  const write = harness.calls.find((call) => call[0] === 'write');
  assert.equal(write[3].target, execPath);
  assert.equal(write[3].icon, execPath);
});

test('기본 설치 위치라도 다른 제품 바로가기는 복구하지 않는다', () => {
  const localAppDataPath = 'C:\\Users\\tester\\AppData\\Local';
  const execPath = buildDefaultInstallExecutablePath(localAppDataPath);
  const harness = createHarness({ target: 'C:\\Apps\\unrelated.exe' });
  const result = configureWindowsNotificationIdentity({
    ...harness,
    platform: 'win32',
    execPath,
    appDataPath: 'C:\\Users\\tester\\AppData\\Roaming',
    localAppDataPath
  });

  assert.equal(result.mode, 'development');
  assert.equal(harness.calls.some((call) => call[0] === 'write'), false);
});

test('설치본 시작 시 production 앱 ID를 가진 기존 작업표시줄 Electron 링크를 복구한다', () => {
  const appDataPath = 'C:\\Users\\tester\\AppData\\Roaming';
  const localAppDataPath = 'C:\\Users\\tester\\AppData\\Local';
  const execPath = buildDefaultInstallExecutablePath(localAppDataPath);
  const [legacyStartMenuPath, legacyTaskbarPath] = buildLegacyElectronShortcutPaths(appDataPath);
  const productShortcutPath = buildStartMenuShortcutPath(appDataPath);
  const harness = createHarness({ target: execPath });
  harness.shell.readShortcutLink = (shortcutPath) => {
    harness.calls.push(['read', shortcutPath]);
    if (shortcutPath === productShortcutPath) return { target: execPath };
    if (shortcutPath === legacyTaskbarPath) {
      return {
        target: 'C:\\project\\node_modules\\electron\\dist\\electron.exe',
        appUserModelId: APP_USER_MODEL_ID
      };
    }
    if (shortcutPath === legacyStartMenuPath) {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    }
    throw new Error(`unexpected shortcut: ${shortcutPath}`);
  };

  const result = configureWindowsNotificationIdentity({
    ...harness,
    platform: 'win32',
    execPath,
    appDataPath,
    localAppDataPath,
    legacyShortcutPathExists: () => true
  });

  assert.deepEqual(result.legacyShortcutsRepaired, [legacyTaskbarPath]);
  const taskbarWrite = harness.calls.find(
    (call) => call[0] === 'write' && call[1] === legacyTaskbarPath
  );
  assert.equal(taskbarWrite[3].target, execPath);
  assert.equal(taskbarWrite[3].args, '');
  assert.equal(taskbarWrite[3].appUserModelId, APP_USER_MODEL_ID);
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

test('개발 실행 작업표시줄 정보에는 앱 경로와 전용 아이콘을 넣는다', () => {
  const details = buildWindowsTaskbarDetails({
    platform: 'win32',
    appUserModelId: 'C:\\project\\node_modules\\electron\\dist\\electron.exe',
    execPath: 'C:\\project\\node_modules\\electron\\dist\\electron.exe',
    appPath: 'C:\\project\\유튜브 라이브',
    isPackaged: false,
    iconPath: 'C:\\project\\assets\\pulse.ico'
  });

  assert.deepEqual(details, {
    appId: 'C:\\project\\node_modules\\electron\\dist\\electron.exe',
    relaunchCommand: 'C:\\project\\node_modules\\electron\\dist\\electron.exe "C:\\project\\유튜브 라이브"',
    relaunchDisplayName: '라이브 펄스',
    appIconPath: 'C:\\project\\assets\\pulse.ico',
    appIconIndex: 0
  });
});

test('설치본 작업표시줄 정보는 제품 exe를 재실행 명령과 아이콘으로 쓴다', () => {
  const details = buildWindowsTaskbarDetails({
    platform: 'win32',
    appUserModelId: APP_USER_MODEL_ID,
    execPath: 'C:\\Program Files\\Live Pulse\\라이브 펄스.exe',
    appPath: 'C:\\ignored',
    isPackaged: true,
    iconPath: 'C:\\ignored.png'
  });

  assert.deepEqual(details, {
    appId: APP_USER_MODEL_ID,
    relaunchCommand: '"C:\\Program Files\\Live Pulse\\라이브 펄스.exe"',
    relaunchDisplayName: '라이브 펄스',
    appIconPath: 'C:\\Program Files\\Live Pulse\\라이브 펄스.exe',
    appIconIndex: 0
  });
});

test('Windows 재실행 명령 인수의 공백, 따옴표와 끝 역슬래시를 안전하게 감싼다', () => {
  assert.equal(quoteWindowsCommandArgument('C:\\plain.exe'), 'C:\\plain.exe');
  assert.equal(quoteWindowsCommandArgument('C:\\with space\\'), '"C:\\with space\\\\"');
  assert.equal(quoteWindowsCommandArgument('say"hello'), '"say\\"hello"');
});

test('우리 production 앱 ID를 가진 이전 Electron 고정 링크만 제품 EXE로 복구한다', () => {
  const execPath = 'C:\\Users\\tester\\AppData\\Local\\Programs\\youtube-live-pulse\\라이브 펄스.exe';
  const ownedPath = 'C:\\Pinned\\Electron.lnk';
  const unrelatedPath = 'C:\\Pinned\\Other.lnk';
  const calls = [];
  const shell = {
    readShortcutLink(shortcutPath) {
      calls.push(['read', shortcutPath]);
      if (shortcutPath === ownedPath) {
        return {
          target: 'C:\\project\\node_modules\\electron\\dist\\electron.exe',
          appUserModelId: APP_USER_MODEL_ID
        };
      }
      return {
        target: 'C:\\other\\electron.exe',
        appUserModelId: 'electron.app.Other'
      };
    },
    writeShortcutLink(shortcutPath, operation, details) {
      calls.push(['write', shortcutPath, operation, details]);
      return true;
    }
  };

  const result = repairOwnedLegacyElectronShortcuts({
    shell,
    shortcutPaths: [ownedPath, unrelatedPath],
    execPath
  });

  assert.deepEqual(result, { repairedPaths: [ownedPath], warning: '' });
  const writes = calls.filter((call) => call[0] === 'write');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], ['write', ownedPath, 'update', {
    target: execPath,
    cwd: path.dirname(execPath),
    args: '',
    description: '라이브 펄스',
    icon: execPath,
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID,
    toastActivatorClsid: TOAST_ACTIVATOR_CLSID
  }]);
});

test('이전 Electron 바로가기 복구 실패는 경고로 반환하고 계속 진행한다', () => {
  const shell = {
    readShortcutLink() {
      return {
        target: 'C:\\project\\electron.exe',
        appUserModelId: APP_USER_MODEL_ID
      };
    },
    writeShortcutLink() {
      return false;
    }
  };
  const result = repairOwnedLegacyElectronShortcuts({
    shell,
    shortcutPaths: ['C:\\Pinned\\Electron.lnk'],
    execPath: 'C:\\Apps\\라이브 펄스.exe'
  });

  assert.deepEqual(result.repairedPaths, []);
  assert.match(result.warning, /갱신 실패/);
});

test('존재하지 않는 이전 Electron 바로가기는 읽지 않고 조용히 건너뛴다', () => {
  let readCalled = false;
  const result = repairOwnedLegacyElectronShortcuts({
    shell: {
      readShortcutLink() {
        readCalled = true;
      }
    },
    shortcutPaths: ['C:\\Missing\\Electron.lnk'],
    execPath: 'C:\\Apps\\라이브 펄스.exe',
    pathExists: () => false
  });

  assert.equal(readCalled, false);
  assert.deepEqual(result, { repairedPaths: [], warning: '' });
});
