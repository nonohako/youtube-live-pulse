'use strict';

const path = require('node:path');

const APP_USER_MODEL_ID = 'kr.local.youtubelivepulse';
const TOAST_ACTIVATOR_CLSID = '{EAFF6767-89DB-4AC0-98A0-9F4FBE3AC3D7}';
const START_MENU_SHORTCUT_NAME = '라이브 펄스.lnk';

function configureWindowsNotificationIdentity({
  app,
  shell,
  isSmokeTest = false,
  platform = process.platform,
  execPath = process.execPath,
  appDataPath
}) {
  if (platform !== 'win32') return { mode: 'unsupported' };

  const shortcutPath = buildStartMenuShortcutPath(appDataPath);
  const shortcut = readMatchingShortcut({
    shell,
    shortcutPath,
    execPath,
    enabled: Boolean(app?.isPackaged) && !isSmokeTest
  });

  if (!shortcut) {
    app.setAppUserModelId(execPath);
    return {
      mode: 'development',
      appUserModelId: execPath,
      shortcutPath
    };
  }

  app.setAppUserModelId(APP_USER_MODEL_ID);
  app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID);

  let shortcutUpdated = false;
  let warning = '';
  try {
    shortcutUpdated = shell.writeShortcutLink(shortcutPath, 'update', {
      target: shortcut.target,
      appUserModelId: APP_USER_MODEL_ID,
      toastActivatorClsid: TOAST_ACTIVATOR_CLSID
    });
    if (!shortcutUpdated) warning = 'Windows 알림용 시작 메뉴 바로가기를 갱신하지 못했습니다.';
  } catch (error) {
    warning = `Windows 알림용 시작 메뉴 바로가기 갱신 실패: ${error.message}`;
  }

  return {
    mode: 'production',
    appUserModelId: APP_USER_MODEL_ID,
    toastActivatorClsid: TOAST_ACTIVATOR_CLSID,
    shortcutPath,
    shortcutUpdated,
    warning
  };
}

function buildStartMenuShortcutPath(appDataPath) {
  if (typeof appDataPath !== 'string' || !appDataPath.trim()) return null;
  return path.join(
    appDataPath,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    START_MENU_SHORTCUT_NAME
  );
}

function readMatchingShortcut({ shell, shortcutPath, execPath, enabled }) {
  if (!enabled || !shortcutPath || typeof execPath !== 'string') return null;
  try {
    const shortcut = shell.readShortcutLink(shortcutPath);
    return sameWindowsPath(shortcut?.target, execPath) ? shortcut : null;
  } catch {
    return null;
  }
}

function sameWindowsPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

module.exports = {
  APP_USER_MODEL_ID,
  START_MENU_SHORTCUT_NAME,
  TOAST_ACTIVATOR_CLSID,
  buildStartMenuShortcutPath,
  configureWindowsNotificationIdentity,
  sameWindowsPath
};
