'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray
} = require('electron');
const { JsonStore, clampInterval } = require('./lib/store');
const { ChannelMonitor } = require('./lib/monitor');
const { resolveChannelInput } = require('./lib/youtube');

const isSmokeTest = process.argv.includes('--smoke-test');
if (isSmokeTest) {
  app.setPath('userData', path.join(process.cwd(), '.smoke-user-data'));
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

app.setName('라이브 펄스');
app.setAppUserModelId('kr.local.youtubelivepulse');

let mainWindow = null;
let tray = null;
let store = null;
let monitor = null;
let isQuitting = false;

app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  store = new JsonStore(path.join(app.getPath('userData'), 'live-pulse.json'));
  store.load();

  createWindow();
  registerIpc();
  if (isSmokeTest) {
    scheduleSmokeCapture();
    return;
  }

  createTray();
  applyLoginSetting(store.data.settings.startAtLogin);

  monitor = new ChannelMonitor({
    store,
    onState: broadcastState,
    onNotify: showNotification,
    onOpen: openInChrome
  });
  monitor.start();

  if (process.argv.includes('--hidden')) {
    mainWindow.hide();
  } else {
    mainWindow.show();
  }
});

app.on('activate', () => showWindow());

app.on('before-quit', () => {
  isQuitting = true;
  monitor?.stop();
});

app.on('window-all-closed', () => {
  // The tray process stays alive even when every window is closed.
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 660,
    show: false,
    backgroundColor: '#0d0f14',
    title: '라이브 펄스',
    icon: path.join(__dirname, '..', 'assets', 'pulse.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.removeMenu();

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) openInChrome(url);
    return { action: 'deny' };
  });
}

function scheduleSmokeCapture() {
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const outputDirectory = path.join(process.cwd(), 'artifacts');
        fs.mkdirSync(outputDirectory, { recursive: true });
        const image = await mainWindow.webContents.capturePage();
        const outputPath = path.join(outputDirectory, 'dashboard-smoke.png');
        fs.writeFileSync(outputPath, image.toPNG());
        process.stdout.write(`SMOKE_SCREENSHOT=${outputPath}\n`);
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      } finally {
        isQuitting = true;
        app.quit();
      }
    }, 700);
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'pulse.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5QAAAABJRU5ErkJggg=='
    );
  }
  icon = icon.resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('라이브 펄스 · YouTube 채널 확인 중');
  rebuildTrayMenu();
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function rebuildTrayMenu() {
  if (!tray || !store) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: '라이브 펄스 열기', click: () => showWindow() },
    { label: '지금 새로고침', click: () => monitor?.runNow({ forceOfficial: true }) },
    { type: 'separator' },
    {
      label: 'Windows 로그인 때 자동 실행',
      type: 'checkbox',
      checked: Boolean(store.data.settings.startAtLogin),
      click: (item) => updateSettings({ startAtLogin: item.checked })
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
}

function registerIpc() {
  ipcMain.handle('state:get', () => withAppInfo(monitor?.publicState() || initialPublicState()));

  ipcMain.handle('channel:add', async (_event, input) => {
    const resolved = await resolveChannelInput(input, store.data.settings.apiKey);
    if (store.data.channels.some((channel) => channel.id === resolved.id)) {
      throw new Error('이미 등록된 채널입니다.');
    }
    store.update((data) => {
      data.channels.push({
        id: resolved.id,
        inputUrl: resolved.url,
        title: '채널 정보 불러오는 중',
        avatarUrl: '',
        addedAt: new Date().toISOString(),
        lastVideoId: null,
        lastPostId: null,
        openedBroadcastIds: [],
        subscriberHistory: []
      });
    });
    broadcastState(monitor.publicState());
    void monitor.runNow({ forceOfficial: true });
    return { ok: true, channelId: resolved.id };
  });

  ipcMain.handle('channel:remove', (_event, channelId) => {
    if (typeof channelId !== 'string') throw new Error('올바르지 않은 채널 ID입니다.');
    store.update((data) => {
      data.channels = data.channels.filter((channel) => channel.id !== channelId);
      data.events = data.events.filter((event) => event.channelId !== channelId);
    });
    broadcastState(monitor.publicState());
    return { ok: true };
  });

  ipcMain.handle('monitor:refresh', async () => {
    await monitor.runNow({ forceOfficial: true });
    return withAppInfo(monitor.publicState());
  });

  ipcMain.handle('settings:update', (_event, partial) => updateSettings(partial));

  ipcMain.handle('url:open', async (_event, url) => {
    if (!isAllowedExternalUrl(url)) throw new Error('허용되지 않은 주소입니다.');
    await openInChrome(url);
    return { ok: true };
  });

  ipcMain.handle('window:hide', () => {
    mainWindow?.hide();
    return { ok: true };
  });

  ipcMain.handle('app:quit', () => {
    isQuitting = true;
    app.quit();
  });
}

function updateSettings(partial) {
  if (!partial || typeof partial !== 'object') throw new Error('설정 값이 올바르지 않습니다.');
  const allowedBooleanKeys = [
    'startAtLogin',
    'autoOpenLive',
    'autoOpenUpcoming',
    'notifyNewVideos',
    'notifyNewPosts'
  ];
  const changed = {};

  for (const key of allowedBooleanKeys) {
    if (Object.hasOwn(partial, key)) changed[key] = Boolean(partial[key]);
  }
  if (Object.hasOwn(partial, 'pollIntervalSeconds')) {
    changed.pollIntervalSeconds = clampInterval(partial.pollIntervalSeconds);
  }
  if (Object.hasOwn(partial, 'apiKey')) {
    const apiKey = String(partial.apiKey || '').trim();
    if (apiKey.length > 256) throw new Error('API 키가 너무 깁니다.');
    changed.apiKey = apiKey;
  }

  store.update((data) => Object.assign(data.settings, changed));
  if (Object.hasOwn(changed, 'startAtLogin')) applyLoginSetting(changed.startAtLogin);
  if (Object.hasOwn(changed, 'pollIntervalSeconds')) monitor?.restart();
  rebuildTrayMenu();
  broadcastState(monitor?.publicState() || initialPublicState());
  if (Object.hasOwn(changed, 'apiKey')) void monitor?.runNow({ forceOfficial: true });
  return withAppInfo(monitor?.publicState() || initialPublicState());
}

function applyLoginSetting(enabled) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    path: process.execPath,
    args: ['--hidden'],
    enabled: Boolean(enabled),
    name: '라이브 펄스'
  });
}

function initialPublicState() {
  return {
    settings: {
      ...store.data.settings,
      apiKey: undefined,
      hasApiKey: Boolean(store.data.settings.apiKey)
    },
    channels: store.data.channels,
    events: store.data.events,
    monitor: { running: false, nextCheckAt: null }
  };
}

function withAppInfo(state) {
  return {
    ...state,
    app: {
      isPackaged: app.isPackaged,
      loginSettingApplied: app.isPackaged
        ? app.getLoginItemSettings().openAtLogin
        : false,
      version: app.getVersion()
    }
  };
}

function broadcastState(state) {
  const payload = withAppInfo(state);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:changed', payload);
  }
  const liveCount = state.channels.filter((channel) => channel.snapshot?.live).length;
  tray?.setToolTip(liveCount
    ? `라이브 펄스 · ${liveCount}개 채널 LIVE`
    : '라이브 펄스 · YouTube 채널 확인 중');
}

function showNotification({ title, body, url }) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title,
    body,
    silent: false,
    icon: path.join(__dirname, '..', 'assets', 'pulse.png')
  });
  if (url) notification.on('click', () => openInChrome(url));
  notification.show();
}

async function openInChrome(url) {
  if (!isAllowedExternalUrl(url)) return false;
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);

  const chromePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (chromePath) {
    const child = spawn(chromePath, [url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return true;
  }
  await shell.openExternal(url);
  return false;
}

function isAllowedExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
