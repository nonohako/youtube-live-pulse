'use strict';

const fs = require('node:fs');
const path = require('node:path');

const APP_USER_MODEL_ID = 'kr.local.youtubelivepulse';
const TOAST_ACTIVATOR_CLSID = '{EAFF6767-89DB-4AC0-98A0-9F4FBE3AC3D7}';
const START_MENU_SHORTCUT_NAME = '라이브 펄스.lnk';
const PRODUCT_EXECUTABLE_NAME = '라이브 펄스.exe';
const PRODUCT_NAME = '라이브 펄스';
const LEGACY_ELECTRON_SHORTCUT_NAME = 'Electron.lnk';

function configureWindowsNotificationIdentity({
  app,
  shell,
  isSmokeTest = false,
  platform = process.platform,
  execPath = process.execPath,
  appDataPath,
  localAppDataPath,
  legacyShortcutPathExists = fs.existsSync
}) {
  if (platform !== 'win32') return { mode: 'unsupported' };

  const shortcutPath = buildStartMenuShortcutPath(appDataPath);
  const shortcut = readShortcut({
    shell,
    shortcutPath,
    enabled: Boolean(app?.isPackaged) && !isSmokeTest
  });
  const isInstalledShortcut = isTrustedInstalledShortcut({
    shortcut,
    execPath,
    localAppDataPath
  });

  if (!isInstalledShortcut) {
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
  const shortcutTargetRepaired = !sameWindowsPath(shortcut.target, execPath);
  let warning = '';
  try {
    shortcutUpdated = shell.writeShortcutLink(shortcutPath, 'update', {
      target: execPath,
      icon: execPath,
      iconIndex: 0,
      appUserModelId: APP_USER_MODEL_ID,
      toastActivatorClsid: TOAST_ACTIVATOR_CLSID
    });
    if (!shortcutUpdated) warning = 'Windows 알림용 시작 메뉴 바로가기를 갱신하지 못했습니다.';
  } catch (error) {
    warning = `Windows 알림용 시작 메뉴 바로가기 갱신 실패: ${error.message}`;
  }

  const legacyRepair = repairOwnedLegacyElectronShortcuts({
    shell,
    shortcutPaths: buildLegacyElectronShortcutPaths(appDataPath),
    execPath,
    pathExists: legacyShortcutPathExists
  });
  warning = [warning, legacyRepair.warning].filter(Boolean).join(' ');

  return {
    mode: 'production',
    appUserModelId: APP_USER_MODEL_ID,
    toastActivatorClsid: TOAST_ACTIVATOR_CLSID,
    shortcutPath,
    shortcutUpdated,
    shortcutTargetRepaired,
    legacyShortcutsRepaired: legacyRepair.repairedPaths,
    warning
  };
}

function buildWindowsTaskbarDetails({
  platform = process.platform,
  appUserModelId,
  execPath = process.execPath,
  appPath,
  isPackaged = false,
  iconPath
}) {
  if (
    platform !== 'win32'
    || typeof appUserModelId !== 'string'
    || !appUserModelId.trim()
    || typeof execPath !== 'string'
    || !execPath.trim()
  ) {
    return null;
  }

  const commandParts = [execPath];
  if (!isPackaged && typeof appPath === 'string' && appPath.trim()) commandParts.push(appPath);

  const details = {
    appId: appUserModelId,
    relaunchCommand: commandParts.map(quoteWindowsCommandArgument).join(' '),
    relaunchDisplayName: PRODUCT_NAME
  };
  const resolvedIconPath = isPackaged ? execPath : iconPath;
  if (typeof resolvedIconPath === 'string' && resolvedIconPath.trim()) {
    details.appIconPath = resolvedIconPath;
    details.appIconIndex = 0;
  }
  return details;
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

function buildDefaultInstallExecutablePath(localAppDataPath) {
  if (typeof localAppDataPath !== 'string' || !localAppDataPath.trim()) return null;
  return path.join(localAppDataPath, 'Programs', 'youtube-live-pulse', PRODUCT_EXECUTABLE_NAME);
}

function buildLegacyElectronShortcutPaths(appDataPath) {
  if (typeof appDataPath !== 'string' || !appDataPath.trim()) return [];
  return [
    path.join(
      appDataPath,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      LEGACY_ELECTRON_SHORTCUT_NAME
    ),
    path.join(
      appDataPath,
      'Microsoft',
      'Internet Explorer',
      'Quick Launch',
      'User Pinned',
      'TaskBar',
      LEGACY_ELECTRON_SHORTCUT_NAME
    )
  ];
}

function repairOwnedLegacyElectronShortcuts({
  shell,
  shortcutPaths,
  execPath,
  pathExists = () => true
}) {
  const repairedPaths = [];
  const warnings = [];
  if (!Array.isArray(shortcutPaths) || typeof execPath !== 'string' || !execPath.trim()) {
    return { repairedPaths, warning: '' };
  }

  for (const shortcutPath of shortcutPaths) {
    try {
      if (!pathExists(shortcutPath)) continue;
      const shortcut = shell.readShortcutLink(shortcutPath);
      const ownsProductionIdentity = (
        typeof shortcut?.appUserModelId === 'string'
        && shortcut.appUserModelId.toLowerCase() === APP_USER_MODEL_ID.toLowerCase()
      );
      const launchesBareElectron = sameWindowsPath(
        path.win32.basename(shortcut?.target || ''),
        'electron.exe'
      );
      if (!ownsProductionIdentity || !launchesBareElectron) continue;

      const updated = shell.writeShortcutLink(shortcutPath, 'update', {
        target: execPath,
        cwd: path.dirname(execPath),
        args: '',
        description: PRODUCT_NAME,
        icon: execPath,
        iconIndex: 0,
        appUserModelId: APP_USER_MODEL_ID,
        toastActivatorClsid: TOAST_ACTIVATOR_CLSID
      });
      if (updated) repairedPaths.push(shortcutPath);
      else warnings.push(`이전 Electron 바로가기 갱신 실패: ${shortcutPath}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        warnings.push(`이전 Electron 바로가기 확인 실패: ${shortcutPath} (${error.message})`);
      }
    }
  }

  return { repairedPaths, warning: warnings.join(' ') };
}

function readShortcut({ shell, shortcutPath, enabled }) {
  if (!enabled || !shortcutPath) return null;
  try {
    return shell.readShortcutLink(shortcutPath);
  } catch {
    return null;
  }
}

function isTrustedInstalledShortcut({ shortcut, execPath, localAppDataPath }) {
  if (!shortcut || typeof execPath !== 'string') return false;
  if (sameWindowsPath(shortcut.target, execPath)) return true;

  const defaultInstallPath = buildDefaultInstallExecutablePath(localAppDataPath);
  return Boolean(
    defaultInstallPath
    && sameWindowsPath(execPath, defaultInstallPath)
    && sameWindowsPath(path.win32.basename(shortcut.target || ''), PRODUCT_EXECUTABLE_NAME)
  );
}

function quoteWindowsCommandArgument(value) {
  const text = String(value);
  if (text && !/[\s"]/u.test(text)) return text;
  return `"${text
    .replace(/(\\*)"/gu, '$1$1\\"')
    .replace(/(\\+)$/u, '$1$1')}"`;
}

function sameWindowsPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

module.exports = {
  APP_USER_MODEL_ID,
  LEGACY_ELECTRON_SHORTCUT_NAME,
  PRODUCT_EXECUTABLE_NAME,
  START_MENU_SHORTCUT_NAME,
  TOAST_ACTIVATOR_CLSID,
  buildDefaultInstallExecutablePath,
  buildLegacyElectronShortcutPaths,
  buildStartMenuShortcutPath,
  buildWindowsTaskbarDetails,
  configureWindowsNotificationIdentity,
  quoteWindowsCommandArgument,
  repairOwnedLegacyElectronShortcuts,
  sameWindowsPath
};
