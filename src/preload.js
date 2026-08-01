'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('livePulse', {
  getState: () => ipcRenderer.invoke('state:get'),
  addChannel: (input) => ipcRenderer.invoke('channel:add', input),
  removeChannel: (channelId) => ipcRenderer.invoke('channel:remove', channelId),
  refresh: () => ipcRenderer.invoke('monitor:refresh'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  importSubscriberHistory: (channelId) => ipcRenderer.invoke('subscriber-history:import', channelId),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  openUrl: (url) => ipcRenderer.invoke('url:open', url),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  }
});
