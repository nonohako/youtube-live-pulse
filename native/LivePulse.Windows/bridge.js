(() => {
  if (window.top !== window) return;
  const session = '__SESSION__';
  const pending = new Map();
  const callbacks = { state: new Set(), active: new Set() };
  let nextId = 0;

  window.chrome.webview.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.session !== session) return;
    if (message.event === 'state' || message.event === 'active') {
      for (const callback of callbacks[message.event]) callback(message.value);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });

  function invoke(method, params = null) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      window.chrome.webview.postMessage({ session, id, method, params });
    });
  }
  function subscribe(kind, callback) {
    if (typeof callback !== 'function') throw new TypeError('callback required');
    callbacks[kind].add(callback);
    return () => callbacks[kind].delete(callback);
  }
  Object.defineProperty(window, 'livePulse', {
    configurable: false,
    value: Object.freeze({
      watchAnalytics: scope => invoke('watchAnalytics', scope),
      getState: () => invoke('getState'),
      addChannel: input => invoke('addChannel', input),
      removeChannel: id => invoke('removeChannel', id),
      refresh: () => invoke('refresh'),
      checkForUpdates: () => invoke('checkForUpdates'),
      importSubscriberHistory: id => invoke('importSubscriberHistory', id),
      updateSettings: settings => invoke('updateSettings', settings),
      importCloudConnection: () => invoke('importCloudConnection'),
      openUrl: url => invoke('openUrl', url),
      hideWindow: () => invoke('hideWindow'),
      quit: () => invoke('quit'),
      onState: callback => subscribe('state', callback),
      onWindowActive: callback => subscribe('active', callback)
    })
  });
})();
