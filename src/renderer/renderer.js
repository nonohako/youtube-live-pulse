'use strict';

let appState = null;
let countdownTimer = null;

const elements = {};

document.addEventListener('DOMContentLoaded', async () => {
  cacheElements();
  bindEvents();
  window.livePulse.onState((state) => {
    appState = state;
    render();
  });

  try {
    appState = await window.livePulse.getState();
    render();
  } catch (error) {
    showError(cleanError(error));
  }

  countdownTimer = window.setInterval(renderMonitorStatus, 1000);
});

window.addEventListener('beforeunload', () => {
  if (countdownTimer) window.clearInterval(countdownTimer);
});

function cacheElements() {
  const ids = [
    'add-channel-form', 'add-channel-button', 'channel-input', 'channel-list',
    'channel-count', 'event-list', 'error-banner', 'refresh-button',
    'global-live-pill', 'sidebar-dot', 'sidebar-status-text', 'sidebar-next-check',
    'settings-button', 'settings-dialog', 'settings-form', 'settings-close',
    'settings-cancel', 'hide-button', 'quit-button', 'clear-api-key',
    'setting-startup', 'setting-live', 'setting-upcoming', 'setting-videos',
    'setting-posts', 'setting-interval', 'setting-api-key', 'api-key-status',
    'startup-help', 'app-version', 'update-button', 'update-status'
  ];
  for (const id of ids) elements[toCamel(id)] = document.getElementById(id);
}

function bindEvents() {
  elements.addChannelForm.addEventListener('submit', handleAddChannel);
  elements.refreshButton.addEventListener('click', handleRefresh);
  elements.updateButton.addEventListener('click', handleUpdateCheck);
  elements.settingsButton.addEventListener('click', openSettings);
  elements.settingsClose.addEventListener('click', () => elements.settingsDialog.close());
  elements.settingsCancel.addEventListener('click', () => elements.settingsDialog.close());
  elements.settingsForm.addEventListener('submit', handleSaveSettings);
  elements.clearApiKey.addEventListener('click', handleClearApiKey);
  elements.hideButton.addEventListener('click', () => window.livePulse.hideWindow());
  elements.quitButton.addEventListener('click', () => {
    if (window.confirm('라이브 펄스를 완전히 종료할까요? 백그라운드 확인도 중단됩니다.')) {
      window.livePulse.quit();
    }
  });

  document.addEventListener('click', async (event) => {
    const openButton = event.target.closest('[data-open-url]');
    if (openButton) {
      await safely(() => window.livePulse.openUrl(openButton.dataset.openUrl));
      return;
    }

    const removeButton = event.target.closest('[data-remove-channel]');
    if (removeButton) {
      const channel = appState?.channels.find((item) => item.id === removeButton.dataset.removeChannel);
      if (window.confirm(`"${channel?.title || '이 채널'}"을 목록에서 삭제할까요?`)) {
        await safely(() => window.livePulse.removeChannel(removeButton.dataset.removeChannel));
      }
      return;
    }

    const navButton = event.target.closest('[data-scroll-target]');
    if (navButton) {
      document.getElementById(navButton.dataset.scrollTarget)?.scrollIntoView({ behavior: 'smooth' });
      document.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active'));
      navButton.classList.add('active');
    }
  });
}

function render() {
  if (!appState) return;
  elements.appVersion.textContent = appState.app?.version ? `v${appState.app.version}` : '';
  const update = appState.app?.update;
  elements.updateStatus.textContent = update?.message || '업데이트 확인 대기 중';
  elements.updateButton.textContent = update?.status === 'downloading'
    ? `업데이트 ${update.percent || 0}%`
    : '업데이트 확인';
  elements.updateButton.disabled = ['checking', 'downloading'].includes(update?.status);
  renderMonitorStatus();
  renderChannels();
  renderEvents();
}

function renderMonitorStatus() {
  if (!appState) return;
  const monitor = appState.monitor || {};
  const channels = appState.channels || [];
  const liveChannels = channels.filter((channel) => channel.snapshot?.live);
  const hasError = channels.some((channel) => channel.status === 'error');

  elements.globalLivePill.classList.toggle('live', liveChannels.length > 0);
  elements.globalLivePill.innerHTML = liveChannels.length
    ? `<span class="status-dot"></span><span>${liveChannels.length}개 채널 LIVE</span>`
    : '<span class="status-dot"></span><span>라이브 없음</span>';

  elements.sidebarDot.className = `status-dot ${hasError ? 'warning' : 'pulse'}`;
  elements.sidebarStatusText.textContent = monitor.running
    ? '지금 확인 중'
    : hasError ? '일부 확인 실패' : '백그라운드 감시 중';

  if (monitor.running) {
    elements.sidebarNextCheck.textContent = 'YouTube 응답 기다리는 중';
  } else if (monitor.nextCheckAt) {
    const seconds = Math.max(0, Math.ceil((new Date(monitor.nextCheckAt).getTime() - Date.now()) / 1000));
    elements.sidebarNextCheck.textContent = `${seconds}초 후 다시 확인`;
  } else {
    elements.sidebarNextCheck.textContent = '다음 확인 예약 중';
  }
  elements.refreshButton.classList.toggle('loading', Boolean(monitor.running));
  elements.refreshButton.disabled = Boolean(monitor.running);
}

function renderChannels() {
  const channels = appState.channels || [];
  elements.channelCount.textContent = `${channels.length} CHANNEL${channels.length === 1 ? '' : 'S'}`;
  if (!channels.length) {
    elements.channelList.innerHTML = `
      <div class="empty-state">
        <strong>등록된 채널이 없습니다.</strong>
        위 입력창에 감시할 YouTube 채널을 추가하세요.
      </div>`;
    return;
  }

  elements.channelList.innerHTML = channels.map(renderChannelCard).join('');
  elements.channelList.querySelectorAll('img').forEach((image) => {
    image.addEventListener('error', () => image.classList.add('hidden'), { once: true });
  });
}

function renderChannelCard(channel) {
  const snapshot = channel.snapshot;
  const metadata = snapshot?.metadata || {
    title: channel.title,
    avatarUrl: channel.avatarUrl,
    subscriberText: '확인 중',
    subscriberCount: null
  };
  const live = snapshot?.live;
  const status = channelStatus(channel);
  const title = metadata.title || channel.title || 'YouTube 채널';
  const avatar = metadata.avatarUrl || channel.avatarUrl;
  const subscriberValue = Number.isFinite(metadata.subscriberCount)
    ? formatCompact(metadata.subscriberCount)
    : metadata.subscriberText || '확인 중';
  const chart = renderSubscriberChart(channel.subscriberHistory || []);
  const warning = snapshot?.warnings?.length
    ? `<div class="warning-line">${escapeHtml(snapshot.warnings.join(' · '))} · 자동으로 재시도합니다.</div>`
    : channel.error
      ? `<div class="warning-line">${escapeHtml(channel.error)}</div>`
      : '';

  return `
    <article class="channel-card ${live ? 'is-live' : ''}">
      <div class="live-stripe"></div>
      <div class="card-content">
        <div class="channel-header">
          ${avatar
            ? `<img class="channel-avatar" src="${escapeAttribute(avatar)}" alt="">`
            : `<div class="avatar-fallback">${escapeHtml(title.slice(0, 1))}</div>`}
          <div class="channel-title">
            <h3 title="${escapeAttribute(title)}">${escapeHtml(title)}</h3>
            <div class="channel-id">${escapeHtml(channel.id)}</div>
          </div>
          ${live
            ? '<span class="live-badge"><span class="status-dot live"></span>LIVE</span>'
            : `<span class="state-badge ${status.className}">${status.label}</span>`}
        </div>

        ${live ? renderBroadcast(live) : ''}

        <div class="subscriber-panel">
          <div>
            <span class="metric-label">구독자</span>
            <strong class="metric-value">${escapeHtml(subscriberValue)}</strong>
            <span class="metric-delta ${chart.delta > 0 ? 'up' : ''}">${escapeHtml(chart.deltaText)}</span>
          </div>
          ${chart.svg}
        </div>

        <div class="content-list">
          ${(snapshot?.upcoming || []).slice(0, 2).map(renderUpcomingRow).join('')}
          ${renderVideoRow(snapshot?.latestVideo)}
          ${renderPostRow(snapshot?.latestPost)}
        </div>

        ${warning}

        <div class="card-footer">
          <span>${snapshot?.checkedAt ? `${formatRelativeTime(snapshot.checkedAt)} 확인` : '첫 확인 대기 중'}</span>
          <button class="remove-button" data-remove-channel="${escapeAttribute(channel.id)}">채널 삭제</button>
        </div>
      </div>
    </article>`;
}

function renderBroadcast(live) {
  return `
    <div class="broadcast-panel">
      ${live.thumbnailUrl
        ? `<img src="${escapeAttribute(live.thumbnailUrl)}" alt="">`
        : '<div></div>'}
      <div>
        <span class="broadcast-kicker">NOW STREAMING</span>
        <strong>${escapeHtml(live.title)}</strong>
      </div>
      <button class="open-overlay" data-open-url="${escapeAttribute(live.url)}" aria-label="라이브 열기"></button>
    </div>`;
}

function renderUpcomingRow(upcoming) {
  return `
    <div class="content-row upcoming">
      <span class="content-icon">◷</span>
      <div class="content-copy">
        <span>예약 방송</span>
        <strong>${escapeHtml(upcoming.title)}</strong>
      </div>
      <span class="row-time">${escapeHtml(formatSchedule(upcoming.scheduledStart))}</span>
      <button class="open-overlay" data-open-url="${escapeAttribute(upcoming.url)}" aria-label="예약 방송 열기"></button>
    </div>`;
}

function renderVideoRow(video) {
  if (!video) {
    return `
      <div class="content-row">
        <span class="content-icon">▶</span>
        <div class="content-copy"><span>최근 동영상</span><strong>정보 확인 중</strong></div>
      </div>`;
  }
  return `
    <div class="content-row">
      <span class="content-icon">▶</span>
      <div class="content-copy">
        <span>최근 동영상</span>
        <strong>${escapeHtml(video.title)}</strong>
      </div>
      <span class="row-time">${escapeHtml(formatRelativeTime(video.publishedAt || video.updatedAt))}</span>
      <button class="open-overlay" data-open-url="${escapeAttribute(video.url)}" aria-label="동영상 열기"></button>
    </div>`;
}

function renderPostRow(post) {
  if (!post) {
    return `
      <div class="content-row post">
        <span class="content-icon">✦</span>
        <div class="content-copy"><span>최근 게시물 · 실험적</span><strong>공개 게시물 없음 또는 확인 중</strong></div>
      </div>`;
  }
  return `
    <div class="content-row post">
      <span class="content-icon">✦</span>
      <div class="content-copy">
        <span>최근 게시물 · 실험적</span>
        <strong>${escapeHtml(post.text)}</strong>
      </div>
      <span class="row-time">${escapeHtml(post.publishedText || '')}</span>
      <button class="open-overlay" data-open-url="${escapeAttribute(post.url)}" aria-label="게시물 열기"></button>
    </div>`;
}

function renderSubscriberChart(history) {
  const samples = history
    .filter((sample) => Number.isFinite(sample.count) && Number.isFinite(new Date(sample.at).getTime()))
    .slice(-60);
  if (!samples.length) {
    return {
      delta: 0,
      deltaText: '추이 수집 대기 중',
      svg: emptyChart()
    };
  }

  const values = samples.map((sample) => sample.count);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const width = 300;
  const height = 58;
  const padding = 4;
  const points = samples.map((sample, index) => {
    const x = samples.length === 1
      ? width - padding
      : padding + (index / (samples.length - 1)) * (width - padding * 2);
    const y = height - padding - ((sample.count - min) / range) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const finalPoint = points.at(-1).split(',');
  const areaPoints = `${padding},${height} ${points.join(' ')} ${width - padding},${height}`;
  const delta = values.at(-1) - values[0];
  const deltaText = samples.length === 1
    ? '오늘부터 추이 수집'
    : `${delta >= 0 ? '+' : ''}${formatCompact(delta)} · 수집 기간`;

  return {
    delta,
    deltaText,
    svg: `
      <svg class="subscriber-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="구독자 추이">
        <defs>
          <linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#38d995" stop-opacity="0.2"/>
            <stop offset="100%" stop-color="#38d995" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <line class="chart-grid" x1="0" y1="${height - 1}" x2="${width}" y2="${height - 1}"/>
        <polygon class="chart-area" points="${areaPoints}"/>
        <polyline class="chart-line" points="${points.join(' ')}"/>
        <circle class="chart-dot" cx="${finalPoint[0]}" cy="${finalPoint[1]}" r="3"/>
      </svg>`
  };
}

function emptyChart() {
  return `
    <svg class="subscriber-chart" viewBox="0 0 300 58" preserveAspectRatio="none" aria-label="구독자 추이 수집 대기">
      <line class="chart-grid" x1="0" y1="57" x2="300" y2="57"/>
      <path class="chart-line" d="M4 48 L296 48" opacity="0.2"/>
    </svg>`;
}

function renderEvents() {
  const events = appState.events || [];
  if (!events.length) {
    elements.eventList.innerHTML = `
      <div class="empty-state">
        <strong>아직 새 알림이 없습니다.</strong>
        라이브, 예약 방송, 새 영상 또는 게시물을 발견하면 여기에 남깁니다.
      </div>`;
    return;
  }
  elements.eventList.innerHTML = events.map((entry) => {
    const channel = appState.channels.find((item) => item.id === entry.channelId);
    const icon = { live: '●', upcoming: '◷', video: '▶', post: '✦', error: '!' }[entry.type] || '•';
    return `
      <div class="event-row">
        <span class="event-type ${escapeAttribute(entry.type)}">${icon}</span>
        <div class="event-copy">
          <strong>${escapeHtml(entry.title)} · ${escapeHtml(channel?.title || entry.channelId)}</strong>
          <span>${escapeHtml(entry.detail || '')}</span>
        </div>
        <span class="event-time">${escapeHtml(formatRelativeTime(entry.at))}</span>
        ${entry.url ? `<button class="open-overlay" data-open-url="${escapeAttribute(entry.url)}" aria-label="알림 항목 열기"></button>` : ''}
      </div>`;
  }).join('');
}

function channelStatus(channel) {
  if (channel.status === 'checking') return { className: 'checking', label: 'CHECKING' };
  if (channel.status === 'error' || channel.status === 'degraded') return { className: 'warning', label: 'RETRYING' };
  if (channel.status === 'online') return { className: '', label: 'OFFLINE' };
  return { className: 'checking', label: 'WAITING' };
}

async function handleAddChannel(event) {
  event.preventDefault();
  const input = elements.channelInput.value.trim();
  if (!input) return;
  elements.addChannelButton.disabled = true;
  elements.addChannelButton.textContent = '확인 중…';
  hideError();
  try {
    await window.livePulse.addChannel(input);
    elements.channelInput.value = '';
  } catch (error) {
    showError(cleanError(error));
  } finally {
    elements.addChannelButton.disabled = false;
    elements.addChannelButton.textContent = '채널 추가';
  }
}

async function handleRefresh() {
  elements.refreshButton.disabled = true;
  hideError();
  try {
    appState = await window.livePulse.refresh();
    render();
  } catch (error) {
    showError(cleanError(error));
  }
}

async function handleUpdateCheck() {
  elements.updateButton.disabled = true;
  await safely(async () => {
    appState = await window.livePulse.checkForUpdates();
    render();
  });
}

function openSettings() {
  const settings = appState.settings;
  elements.settingStartup.checked = settings.startAtLogin;
  elements.settingLive.checked = settings.autoOpenLive;
  elements.settingUpcoming.checked = settings.autoOpenUpcoming;
  elements.settingVideos.checked = settings.notifyNewVideos;
  elements.settingPosts.checked = settings.notifyNewPosts;
  elements.settingInterval.value = settings.pollIntervalSeconds;
  elements.settingApiKey.value = '';
  elements.settingApiKey.placeholder = settings.hasApiKey
    ? '저장된 키 유지 (변경할 때만 입력)'
    : '입력하지 않아도 작동합니다';
  elements.apiKeyStatus.textContent = settings.hasApiKey
    ? 'API 키 저장됨 · 공식 구독자 통계를 10분마다 보강합니다.'
    : 'API 키 없음 · 공개 페이지에서 통계를 읽습니다.';
  elements.startupHelp.textContent = appState.app?.isPackaged
    ? 'Windows 시작 앱 설정에 반영됩니다.'
    : '개발 실행 중에는 등록하지 않으며, 설치본에서 적용됩니다.';
  elements.settingsDialog.showModal();
}

async function handleSaveSettings(event) {
  event.preventDefault();
  const update = {
    startAtLogin: elements.settingStartup.checked,
    autoOpenLive: elements.settingLive.checked,
    autoOpenUpcoming: elements.settingUpcoming.checked,
    notifyNewVideos: elements.settingVideos.checked,
    notifyNewPosts: elements.settingPosts.checked,
    pollIntervalSeconds: Number(elements.settingInterval.value)
  };
  if (elements.settingApiKey.value.trim()) update.apiKey = elements.settingApiKey.value.trim();

  await safely(async () => {
    appState = await window.livePulse.updateSettings(update);
    render();
    elements.settingsDialog.close();
  });
}

async function handleClearApiKey() {
  if (!appState.settings.hasApiKey) return;
  if (!window.confirm('저장된 YouTube Data API 키를 삭제할까요?')) return;
  await safely(async () => {
    appState = await window.livePulse.updateSettings({ apiKey: '' });
    elements.settingApiKey.value = '';
    elements.settingApiKey.placeholder = '입력하지 않아도 작동합니다';
    elements.apiKeyStatus.textContent = 'API 키 없음 · 공개 페이지에서 통계를 읽습니다.';
    render();
  });
}

async function safely(action) {
  hideError();
  try {
    return await action();
  } catch (error) {
    showError(cleanError(error));
    return null;
  }
}

function showError(message) {
  elements.errorBanner.textContent = message;
  elements.errorBanner.classList.remove('hidden');
  elements.errorBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideError() {
  elements.errorBanner.classList.add('hidden');
  elements.errorBanner.textContent = '';
}

function cleanError(error) {
  return String(error?.message || error || '요청을 처리하지 못했습니다.')
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '');
}

function formatCompact(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat('ko-KR', {
    notation: 'compact',
    maximumFractionDigits: 2
  }).format(numeric);
}

function formatRelativeTime(value) {
  if (!value) return '';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return String(value);
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('ko-KR', { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, 'day');
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' }).format(timestamp);
}

function formatSchedule(value) {
  if (!value) return '시간 미정';
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return '시간 미정';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(timestamp);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
