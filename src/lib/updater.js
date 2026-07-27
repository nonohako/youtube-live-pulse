'use strict';

const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;

class AppUpdater {
  constructor({ getParentWindow, onState, onBeforeInstall }) {
    this.getParentWindow = getParentWindow;
    this.onState = onState;
    this.onBeforeInstall = onBeforeInstall;
    this.interval = null;
    this.started = false;
    this.state = {
      status: app.isPackaged ? 'idle' : 'development',
      currentVersion: app.getVersion(),
      availableVersion: null,
      percent: null,
      message: app.isPackaged
        ? '업데이트 확인 대기 중'
        : '개발 실행에서는 업데이트를 확인하지 않습니다.',
      checkedAt: null
    };
  }

  start() {
    if (this.started || !app.isPackaged) return;
    this.started = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = console;
    this.#bindEvents();

    setTimeout(() => void this.check(), 8_000);
    this.interval = setInterval(() => void this.check(), UPDATE_INTERVAL_MS);
    this.interval.unref?.();
  }

  stop() {
    clearInterval(this.interval);
    this.interval = null;
  }

  getState() {
    return { ...this.state };
  }

  async check() {
    if (!app.isPackaged) return this.getState();
    if (['checking', 'downloading', 'downloaded'].includes(this.state.status)) {
      return this.getState();
    }
    this.#setState({
      status: 'checking',
      message: '새 버전을 확인하는 중…',
      checkedAt: new Date().toISOString()
    });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.#setState({
        status: 'error',
        message: friendlyUpdateError(error)
      });
    }
    return this.getState();
  }

  #bindEvents() {
    autoUpdater.on('checking-for-update', () => {
      this.#setState({
        status: 'checking',
        message: '새 버전을 확인하는 중…',
        checkedAt: new Date().toISOString()
      });
    });

    autoUpdater.on('update-not-available', () => {
      this.#setState({
        status: 'idle',
        availableVersion: null,
        percent: null,
        message: '최신 버전입니다.',
        checkedAt: new Date().toISOString()
      });
    });

    autoUpdater.on('update-available', (info) => {
      this.#setState({
        status: 'downloading',
        availableVersion: info.version,
        percent: 0,
        message: `v${info.version} 다운로드 중…`
      });
    });

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
      this.#setState({
        status: 'downloading',
        percent,
        message: `업데이트 다운로드 ${percent}%`
      });
    });

    autoUpdater.on('update-downloaded', async (info) => {
      this.#setState({
        status: 'downloaded',
        availableVersion: info.version,
        percent: 100,
        message: `v${info.version} 설치 준비 완료`
      });

      const options = {
        type: 'info',
        title: '라이브 펄스 업데이트',
        message: `라이브 펄스 v${info.version} 업데이트가 준비되었습니다.`,
        detail: '지금 재시작하면 자동으로 설치됩니다. 나중을 선택하면 앱을 종료할 때 설치됩니다.',
        buttons: ['지금 재시작', '나중에'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      };
      const parent = this.getParentWindow?.();
      const result = parent && !parent.isDestroyed() && parent.isVisible()
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);

      if (result.response === 0) {
        this.onBeforeInstall?.();
        autoUpdater.quitAndInstall(false, true);
      }
    });

    autoUpdater.on('error', (error) => {
      this.#setState({
        status: 'error',
        message: friendlyUpdateError(error)
      });
    });
  }

  #setState(partial) {
    this.state = { ...this.state, ...partial };
    this.onState?.(this.getState());
  }
}

function friendlyUpdateError(error) {
  const message = String(error?.message || error || '');
  if (/net::ERR_INTERNET_DISCONNECTED|ENOTFOUND|ECONNREFUSED/i.test(message)) {
    return '인터넷 연결 후 업데이트를 다시 확인합니다.';
  }
  if (/404|latest\.yml/i.test(message)) {
    return '게시된 업데이트 정보를 찾지 못했습니다.';
  }
  return '업데이트 확인에 실패했습니다. 나중에 다시 시도합니다.';
}

module.exports = { AppUpdater, friendlyUpdateError };
