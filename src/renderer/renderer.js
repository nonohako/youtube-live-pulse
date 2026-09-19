'use strict';

let appState = null;
let chartPreferencesMemory = null;
let countdownTimer = null;
let subscriberChartChannelId = null;
let subscriberChartRange = readChartPreferences().subscriberRange;
let subscriberChartSelection = null;
let subscriberChartViewport = null;
let detailChartModel = null;
let detailChartDrag = null;
let videoViewChartChannelId = null;
let videoViewChartVideoId = null;
let videoViewChartRange = readChartPreferences().videoRange;
let videoViewChartViewport = null;
let videoViewChartModel = null;

const CHART_MINIMUM_SPAN_MS = 24 * 60 * 60 * 1000;

const elements = {};
const hoverFrames = window.LivePulseChartHover.scheduler(requestAnimationFrame, cancelAnimationFrame);
const formatterCache = new Map();
function cachedFormatter(kind, options) {
  const key = kind + JSON.stringify(options);
  if (!formatterCache.has(key)) formatterCache.set(key, new Intl[kind]('ko-KR', options));
  return formatterCache.get(key);
}
let chartRefreshTimer = null;
let lastChartPointerAt = 0;
let subscriberRenderKey = '', videoRenderKey = '';
function historyRenderKey(history = []) {
  return [history.length, history[0]?.at, history[0]?.count, history.at(-1)?.at, history.at(-1)?.count].join(':');
}
function subscriberDataKey() {
  return subscriberChartChannelId + ':' + historyRenderKey(appState?.channels.find(c => c.id === subscriberChartChannelId)?.subscriberHistory);
}
function videoDataKey() {
  return videoViewChartChannelId + ':' + videoViewChartVideoId + ':' + historyRenderKey(appState?.channels.find(c => c.id === videoViewChartChannelId)?.videoViewHistories?.find(v => v.videoId === videoViewChartVideoId)?.samples);
}
function queueHover(key, event, callback) {
  lastChartPointerAt = performance.now();
  hoverFrames.move(key, event, latest => { if (latest.target?.isConnected) callback(latest); });
}
function refreshFromState() {
  clearTimeout(chartRefreshTimer);
  if (document.querySelector('dialog[open]') && performance.now() - lastChartPointerAt < 200) {
    chartRefreshTimer = setTimeout(refreshFromState, 220);
    return;
  }
  render();
}

document.addEventListener('DOMContentLoaded', async () => {
  cacheElements();
  bindEvents();
  window.livePulse.onState((state) => {
    if (state.channels.some(c => c.historiesUnchanged && !appState?.channels.some(old => old.id === c.id))) {
      void window.livePulse.getState().then(full => { appState = full; refreshFromState(); }).catch(error => showError(cleanError(error)));
      return;
    }
    appState = {...state, channels: state.channels.map(channel => {
      if (!channel.historiesUnchanged) return channel;
      const previous = appState.channels.find(old => old.id === channel.id);
      return {...channel, subscriberHistory: previous.subscriberHistory, videoViewHistories: previous.videoViewHistories};
    })};
    refreshFromState();
  });

  try {
    appState = await window.livePulse.getState();
    render();
    const smokeParams = new URLSearchParams(window.location.search);
    if (smokeParams.has('smokeChart') && appState.channels[0]) {
      openSubscriberChart(
        appState.channels[0].id,
        smokeParams.get('chartRange') || '30d',
        smokeParams.get('chartSelection') === '1'
      );
      if (smokeParams.get('chartZoom') === '1') {
        window.requestAnimationFrame(() => {
          const svg = elements.subscriberDialog.querySelector('#subscriber-detail-svg');
          const bounds = svg?.getBoundingClientRect();
          if (!svg || !bounds?.width) return;
          svg.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: bounds.left + bounds.width * 0.65,
            clientY: bounds.top + bounds.height * 0.5,
            deltaY: -120
          }));
        });
      }
    }
    if (smokeParams.has('smokeVideoViews') && appState.channels[0]) {
      const history = appState.channels[0].videoViewHistories?.[0];
      if (history) {
        openVideoViewChart(appState.channels[0].id, history.videoId);
        window.requestAnimationFrame(() => {
          const svg = elements.videoViewDialog.querySelector('#video-view-detail-svg');
          const bounds = svg?.getBoundingClientRect();
          if (!svg || !bounds?.width) return;
          svg.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: bounds.left + bounds.width * 0.7,
            clientY: bounds.top + bounds.height * 0.5,
            deltaY: -120
          }));
        });
      }
    }
    if (smokeParams.has('smokeSettings')) openSettings();
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
    'setting-posts', 'setting-subscriber-chart-mode', 'setting-interval',
    'setting-api-key', 'api-key-status',
    'setting-cloud-url', 'setting-cloud-token', 'cloud-sync-status',
    'import-cloud-connection',
    'startup-help', 'app-version', 'update-button', 'update-status',
    'subscriber-dialog', 'subscriber-close', 'subscriber-dialog-title',
    'subscriber-import-button', 'subscriber-import-status', 'subscriber-detail-content',
    'video-view-dialog', 'video-view-close', 'video-view-dialog-title',
    'video-view-open', 'video-view-select', 'video-view-detail-content'
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
  elements.subscriberClose.addEventListener('click', () => elements.subscriberDialog.close());
  elements.subscriberImportButton.addEventListener('click', handleSubscriberImport);
  elements.subscriberDialog.addEventListener('close', () => {
    if (elements.subscriberDialog.open) return;
    hideDetailChartTooltip();
    requestAnimationFrame(render);
    subscriberChartChannelId = null;
    subscriberChartSelection = null;
    subscriberChartViewport = null;
    detailChartModel = null;
    detailChartDrag = null;
    elements.subscriberImportStatus.textContent = '';
  });
  elements.subscriberDialog.addEventListener('pointerdown', handleDetailChartPointerDown);
  elements.subscriberDialog.addEventListener('pointermove', event => {
    if (detailChartDrag) handleDetailChartPointerMove(event);
    else queueHover('subscriber', event, handleDetailChartPointerMove);
  });
  elements.subscriberDialog.addEventListener('pointerup', handleDetailChartPointerUp);
  elements.subscriberDialog.addEventListener('pointercancel', handleDetailChartPointerCancel);
  elements.subscriberDialog.addEventListener('pointerleave', hideDetailChartTooltip);
  elements.subscriberDialog.addEventListener('wheel', handleDetailChartWheel, { passive: false });
  elements.videoViewClose.addEventListener('click', () => elements.videoViewDialog.close());
  elements.videoViewDialog.addEventListener('close', () => {
    if (elements.videoViewDialog.open) return;
    hideVideoViewTooltip();
    requestAnimationFrame(render);
    videoViewChartChannelId = null;
    videoViewChartVideoId = null;
    videoViewChartViewport = null;
    videoViewChartModel = null;
  });
  elements.videoViewSelect.addEventListener('change', () => {
    videoViewChartVideoId = elements.videoViewSelect.value;
    videoViewChartViewport = null;
    renderVideoViewDetail();
  });
  elements.videoViewDialog.addEventListener('pointermove', event => queueHover('video', event, handleVideoViewPointerMove));
  elements.videoViewDialog.addEventListener('pointerleave', hideVideoViewTooltip);
  elements.videoViewDialog.addEventListener('wheel', handleVideoViewWheel, { passive: false });
  elements.settingsForm.addEventListener('submit', handleSaveSettings);
  elements.clearApiKey.addEventListener('click', handleClearApiKey);
  elements.importCloudConnection.addEventListener('click', () => safely(async () => {
    const result = await window.livePulse.importCloudConnection();
    if (result.canceled) return;
    appState = await window.livePulse.getState();
    elements.settingCloudUrl.value = appState.settings.cloudUrl || '';
    elements.settingCloudToken.value = '';
    elements.settingCloudToken.placeholder = '저장된 연결 키 유지';
    elements.cloudSyncStatus.textContent = '연결 파일 적용 완료 · 동기화 중';
    render();
  }));
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

    const subscriberButton = event.target.closest('[data-subscriber-chart]');
    if (subscriberButton) {
      openSubscriberChart(subscriberButton.dataset.subscriberChart);
      return;
    }

    const rangeButton = event.target.closest('[data-chart-range]');
    if (rangeButton) {
      subscriberChartRange = rangeButton.dataset.chartRange;
      saveChartPreference('subscriberRange', subscriberChartRange);
      subscriberChartSelection = null;
      subscriberChartViewport = null;
      detailChartDrag = null;
      renderSubscriberDetail();
      return;
    }

    const videoViewButton = event.target.closest('[data-video-view-chart]');
    if (videoViewButton) {
      openVideoViewChart(
        videoViewButton.dataset.videoViewChannel,
        videoViewButton.dataset.videoViewChart
      );
      return;
    }

    const videoViewRangeButton = event.target.closest('[data-video-view-range]');
    if (videoViewRangeButton) {
      videoViewChartRange = videoViewRangeButton.dataset.videoViewRange;
      saveChartPreference('videoRange', videoViewChartRange);
      videoViewChartViewport = null;
      renderVideoViewDetail();
      return;
    }

    const resetVideoViewZoom = event.target.closest('[data-reset-video-view-zoom]');
    if (resetVideoViewZoom) {
      videoViewChartViewport = null;
      renderVideoViewDetail();
      return;
    }

    const resetChartZoom = event.target.closest('[data-reset-chart-zoom]');
    if (resetChartZoom) {
      subscriberChartViewport = null;
      subscriberChartSelection = null;
      detailChartDrag = null;
      renderSubscriberDetail();
      return;
    }

    const clearChartSelection = event.target.closest('[data-clear-chart-selection]');
    if (clearChartSelection) {
      subscriberChartSelection = null;
      detailChartDrag = null;
      renderSubscriberDetail();
      return;
    }

    const navButton = event.target.closest('[data-scroll-target]');
    if (navButton) {
      showViewsPage(false);
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
    : '앱 업데이트 확인';
  elements.updateButton.disabled = ['checking', 'downloading'].includes(update?.status);
  renderMonitorStatus();
  if (!document.querySelector('dialog[open]')) {
    renderChannels(); renderEvents(); renderViewsPanel();
  }
  if (document.getElementById('compare-dialog').open) refreshComparisonIfChanged();
  if (elements.subscriberDialog.open && subscriberDataKey() !== subscriberRenderKey) renderSubscriberDetail();
  if (elements.videoViewDialog.open && videoDataKey() !== videoRenderKey) renderVideoViewDetail();
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
  const chart = renderSubscriberChart(
    channel.subscriberHistory || [],
    readChartPreferences().subscriberMode
  );
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

        <button type="button" class="subscriber-panel" data-subscriber-chart="${escapeAttribute(channel.id)}"
          aria-label="${escapeAttribute(title)} 구독자 상세 차트 열기">
          <div>
            <span class="metric-label">구독자</span>
            <strong class="metric-value">${escapeHtml(subscriberValue)}</strong>
            <span class="metric-delta ${chart.delta > 0 ? 'up' : ''}">${escapeHtml(chart.deltaText)}</span>
            <span class="metric-chart-hint">상세 차트 보기 ↗</span>
          </div>
          ${chart.svg}
        </button>

        <div class="content-list">
          ${(snapshot?.upcoming || []).slice(0, 2).map(renderUpcomingRow).join('')}
          ${renderVideoRow(snapshot?.latestVideo, channel)}
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

function renderVideoRow(video, channel) {
  if (!video) {
    return `
      <div class="content-row">
        <span class="content-icon">▶</span>
        <div class="content-copy"><span>최근 동영상</span><strong>정보 확인 중</strong></div>
      </div>`;
  }
  const history = (channel?.videoViewHistories || []).find((item) => item.videoId === video.id);
  const latestSample = history?.samples?.at(-1);
  const viewCount = Number.isFinite(Number(video.viewCount))
    ? Number(video.viewCount)
    : Number(latestSample?.count);
  return `
    <div class="content-row">
      <span class="content-icon">▶</span>
      <div class="content-copy">
        <span>최근 동영상${Number.isFinite(viewCount) ? ` · 조회수 ${escapeHtml(formatNumber(viewCount))}회` : ''}</span>
        <strong>${escapeHtml(video.title)}</strong>
      </div>
      <div class="video-row-actions">
        <span class="row-time">${escapeHtml(formatRelativeTime(video.publishedAt || video.updatedAt))}</span>
        ${history?.samples?.length ? `<button type="button" class="video-chart-button" data-video-view-channel="${escapeAttribute(channel.id)}" data-video-view-chart="${escapeAttribute(video.id)}">조회수 추이</button>` : ''}
      </div>
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

function renderSubscriberChart(history, displayMode = 'samples') {
  const math = window.LivePulseChartMath;
  const allSamples = math.normalizeSamples(history);
  const visualSamples = displayMode === 'daily'
    ? math.collapseSamplesByLocalDate(allSamples)
    : allSamples;
  const samples = visualSamples.slice(-60);
  if (!allSamples.length) {
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
  const delta = allSamples.at(-1).count - allSamples[0].count;
  const deltaText = allSamples.length === 1
    ? '오늘부터 추이 수집'
    : `${delta >= 0 ? '+' : ''}${formatNumber(delta)} · 전체 수집 기간`;

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

function openSubscriberChart(channelId, initialRange = readChartPreferences().subscriberRange, selectSmokeRange = false) {
  const channel = appState?.channels.find((item) => item.id === channelId);
  if (!channel) return;
  subscriberChartChannelId = channelId;
  subscriberChartRange = ['7d', '30d', '90d', '1y', 'all'].includes(initialRange)
    ? initialRange
    : '30d';
  subscriberChartSelection = null;
  subscriberChartViewport = null;
  detailChartDrag = null;
  elements.subscriberImportStatus.textContent = '';
  if (selectSmokeRange) {
    const math = window.LivePulseChartMath;
    const completed = math.analyzeGrowthForRange(
      channel.subscriberHistory || [],
      subscriberChartRange
    ).daily;
    if (completed.length) {
      subscriberChartSelection = {
        startTime: completed[Math.max(0, completed.length - 7)].dayTimestamp,
        endTime: completed.at(-1).dayTimestamp
      };
    }
  }
  renderSubscriberDetail();
  if (!elements.subscriberDialog.open) elements.subscriberDialog.showModal();
}

function openVideoViewChart(channelId, videoId) {
  const channel = appState?.channels.find((item) => item.id === channelId);
  const histories = (channel?.videoViewHistories || []).filter((history) => history.samples?.length);
  if (!channel || !histories.length) return;
  videoViewChartChannelId = channelId;
  videoViewChartVideoId = histories.some((history) => history.videoId === videoId)
    ? videoId
    : histories[0].videoId;
  videoViewChartRange = readChartPreferences().videoRange;
  videoViewChartViewport = null;
  renderVideoViewDetail();
  if (!elements.videoViewDialog.open) elements.videoViewDialog.showModal();
}

async function handleSubscriberImport() {
  if (!subscriberChartChannelId) return;
  const originalText = elements.subscriberImportButton.textContent;
  elements.subscriberImportButton.disabled = true;
  elements.subscriberImportButton.textContent = '가져오는 중…';
  elements.subscriberImportStatus.textContent = '';
  hideError();

  try {
    const result = await window.livePulse.importSubscriberHistory(subscriberChartChannelId);
    if (!result || result.canceled) return;
    appState = await window.livePulse.getState();
    render();

    const details = [
      `${result.fileName}에서 ${formatNumber(result.added)}일 추가`,
      `기존 ${formatNumber(result.skippedExisting)}일 유지`
    ];
    if (result.skippedInvalid) details.push(`읽지 못한 행 ${formatNumber(result.skippedInvalid)}개 제외`);
    if (result.skippedDuplicate) details.push(`파일 안 중복 날짜 ${formatNumber(result.skippedDuplicate)}개 정리`);
    elements.subscriberImportStatus.textContent = details.join(' · ');
  } catch (error) {
    showError(cleanError(error));
    elements.subscriberImportStatus.textContent = '가져오지 못했습니다. 위 오류 내용을 확인해 주세요.';
  } finally {
    elements.subscriberImportButton.disabled = false;
    elements.subscriberImportButton.textContent = originalText;
  }
}

function renderSubscriberDetail() {
  subscriberRenderKey = subscriberDataKey();
  hoverFrames.clear('subscriber');
  const channel = appState?.channels.find((item) => item.id === subscriberChartChannelId);
  if (!channel) {
    elements.subscriberDialog.close();
    return;
  }

  const title = channel.snapshot?.metadata?.title || channel.title || 'YouTube 채널';
  elements.subscriberDialogTitle.textContent = title;
  elements.subscriberDialog.querySelectorAll('[data-chart-range]').forEach((button) => {
    button.classList.toggle('active', button.dataset.chartRange === subscriberChartRange);
  });

  const math = window.LivePulseChartMath;
  const now = Date.now();
  const displayMode = readChartPreferences().subscriberMode;
  const metric = readChartPreferences().subscriberMetric;
  elements.subscriberDialog.querySelectorAll('[data-analysis-metric]').forEach(b => { b.classList.toggle('active', b.dataset.analysisMetric === metric); b.setAttribute('aria-pressed', b.dataset.analysisMetric === metric); });
  document.getElementById('subscriber-chart-mode').value = displayMode;
  const displayHistory = displayMode === 'daily'
    ? math.collapseSamplesByLocalDate(channel.subscriberHistory || [])
    : channel.subscriberHistory || [];
  const baseSamples = math.filterSamples(displayHistory, subscriberChartRange, now);
  const baseTimeAxis = math.buildTimeAxis(baseSamples, subscriberChartRange, now);
  if (!baseSamples.length) {
    subscriberChartViewport = null;
    detailChartModel = null;
    elements.subscriberDialog.querySelector('[data-reset-chart-zoom]').hidden = true;
    elements.subscriberDetailContent.innerHTML = `
      <div class="detail-chart-empty">
        <strong>아직 이 기간의 구독자 기록이 없습니다.</strong>
        <span>앱이 채널을 확인하면서 기록을 모으면 여기에 상세 차트가 표시됩니다.</span>
      </div>`;
    return;
  }

  if (subscriberChartViewport) {
    subscriberChartViewport = math.zoomTimeWindow(
      subscriberChartViewport,
      baseTimeAxis,
      (subscriberChartViewport.startTime + subscriberChartViewport.endTime) / 2,
      1,
      CHART_MINIMUM_SPAN_MS
    );
    if (isSameTimeWindow(subscriberChartViewport, baseTimeAxis)) subscriberChartViewport = null;
  }
  let samples = subscriberChartViewport
    ? math.filterSamplesInTimeWindow(
      baseSamples,
      subscriberChartViewport.startTime,
      subscriberChartViewport.endTime
    )
    : baseSamples;
  if (!samples.length) {
    subscriberChartViewport = null;
    samples = baseSamples;
  }
  const timeAxis = subscriberChartViewport
    ? math.buildTimeWindowAxis(
      subscriberChartViewport.startTime,
      subscriberChartViewport.endTime
    )
    : baseTimeAxis;
  const summary = math.summarizeSamples(samples);
  const resetZoomButton = elements.subscriberDialog.querySelector('[data-reset-chart-zoom]');
  resetZoomButton.hidden = !subscriberChartViewport;

  const changeClass = summary.change > 0 ? 'up' : summary.change < 0 ? 'down' : '';
  const changeText = `${summary.change >= 0 ? '+' : ''}${formatNumber(summary.change)}`;
  const slopeText = `${summary.slopePerDay >= 0 ? '+' : ''}${formatTrend(summary.slopePerDay)}/일`;
  const rangeLabel = subscriberChartViewport ? '확대 구간' : ({
    '7d': '7일',
    '30d': '30일',
    '90d': '90일',
    '1y': '1년',
    all: '전체'
  }[subscriberChartRange] || '선택 기간');

  const growth = subscriberChartViewport
    ? math.analyzeGrowthForTimeWindow(
      channel.subscriberHistory || [],
      subscriberChartViewport.startTime,
      subscriberChartViewport.endTime,
      now
    )
    : math.analyzeGrowthForRange(
      channel.subscriberHistory || [],
      subscriberChartRange,
      now
    );
  const growthTimeAxis = math.buildCompletedDayAxis(growth.daily);
  let selectionSummary = subscriberChartSelection
    ? math.summarizeDailyRange(
      growth.daily,
      subscriberChartSelection.startTime,
      subscriberChartSelection.endTime
    )
    : null;
  if (selectionSummary && !selectionSummary.dayCount) {
    subscriberChartSelection = null;
    selectionSummary = null;
  }
  const chart = buildDetailChart(
    samples,
    math.linearRegression(samples),
    timeAxis,
    growth.daily,
    subscriberChartSelection,
    displayMode,
    { metric }
  );
  const growthChart = buildGrowthChart(growth.daily, growthTimeAxis);
  detailChartModel = {
    ...chart.model,
    baseSamples,
    fullTimeAxis: baseTimeAxis
  };
  elements.subscriberDetailContent.innerHTML = `
    ${analysisOverview(subscriberChartViewport ? math.filterSamplesInTimeWindow(math.filterSamples(channel.subscriberHistory, subscriberChartRange, now), timeAxis.startTime, timeAxis.endTime) : math.filterSamples(channel.subscriberHistory, subscriberChartRange, now), '명', growth.daily)}
    <section class="analysis-plot-panel">
      ${analysisCaption(samples, metric, '명', displayMode)}
      ${chart.svg}
      ${renderSelectionSummary(selectionSummary)}
    </section>
    ${renderGrowthAnalysis(growth, growthChart)}
    ${analysisDailyTable(growth.daily, '명')}
    `;
}

function renderVideoViewDetail() {
  videoRenderKey = videoDataKey();
  hoverFrames.clear('video');
  const channel = appState?.channels.find((item) => item.id === videoViewChartChannelId);
  const histories = (channel?.videoViewHistories || []).filter((history) => history.samples?.length);
  if (!channel || !histories.length) {
    if (elements.videoViewDialog.open) elements.videoViewDialog.close();
    return;
  }

  let history = histories.find((item) => item.videoId === videoViewChartVideoId) || histories[0];
  videoViewChartVideoId = history.videoId;
  elements.videoViewSelect.innerHTML = histories.map((item) => (
    `<option value="${escapeAttribute(item.videoId)}"${item.videoId === history.videoId ? ' selected' : ''}>${escapeHtml(item.title || item.videoId)}</option>`
  )).join('');
  elements.videoViewDialogTitle.textContent = history.title || '영상 조회수 추이';
  const thumbnail = document.getElementById('analysis-video-thumbnail');
  if (thumbnail) thumbnail.src = `https://i.ytimg.com/vi/${encodeURIComponent(history.videoId)}/mqdefault.jpg`;
  elements.videoViewOpen.dataset.openUrl = history.url || `https://www.youtube.com/watch?v=${history.videoId}`;
  elements.videoViewDialog.querySelectorAll('[data-video-view-range]').forEach((button) => {
    button.classList.toggle('active', button.dataset.videoViewRange === videoViewChartRange);
  });

  const math = window.LivePulseChartMath;
  const now = Date.now();
  const displayMode = readChartPreferences().videoMode;
  const metric = readChartPreferences().videoMetric;
  elements.videoViewDialog.querySelectorAll('[data-analysis-metric]').forEach(b => { b.classList.toggle('active', b.dataset.analysisMetric === metric); b.setAttribute('aria-pressed', b.dataset.analysisMetric === metric); });
  document.getElementById('video-chart-mode').value = displayMode;
  const visualHistory = displayMode === 'daily' ? math.collapseSamplesByLocalDate(history.samples || []) : history.samples || [];
  const baseSamples = math.filterSamples(visualHistory, videoViewChartRange, now);
  const resetZoomButton = elements.videoViewDialog.querySelector('[data-reset-video-view-zoom]');
  if (!baseSamples.length) {
    videoViewChartViewport = null;
    videoViewChartModel = null;
    resetZoomButton.hidden = true;
    elements.videoViewDetailContent.innerHTML = `
      <div class="detail-chart-empty">
        <strong>이 기간에 수집된 조회수 기록이 없습니다.</strong>
        <span>더 긴 기간을 선택하거나, 앱이 최근 영상의 조회수를 수집할 때까지 기다려 주세요.</span>
      </div>`;
    return;
  }

  const lastSampleTime = baseSamples.at(-1).timestamp;
  const baseTimeAxis = math.buildTimeAxis(baseSamples, videoViewChartRange, lastSampleTime);
  if (videoViewChartViewport) {
    videoViewChartViewport = math.zoomTimeWindow(
      videoViewChartViewport,
      baseTimeAxis,
      (videoViewChartViewport.startTime + videoViewChartViewport.endTime) / 2,
      1,
      CHART_MINIMUM_SPAN_MS
    );
    if (isSameTimeWindow(videoViewChartViewport, baseTimeAxis)) videoViewChartViewport = null;
  }

  let samples = videoViewChartViewport
    ? math.filterSamplesInTimeWindow(
      baseSamples,
      videoViewChartViewport.startTime,
      videoViewChartViewport.endTime
    )
    : baseSamples;
  if (!samples.length) {
    videoViewChartViewport = null;
    samples = baseSamples;
  }
  const timeAxis = videoViewChartViewport
    ? math.buildTimeWindowAxis(videoViewChartViewport.startTime, videoViewChartViewport.endTime)
    : baseTimeAxis;
  const summary = math.summarizeSamples(samples);
  const periodGrowth = samples[0].count > 0
    ? (summary.change / samples[0].count) * 100
    : null;
  const changeClass = summary.change > 0 ? 'up' : summary.change < 0 ? 'down' : '';
  const rangeLabel = videoViewChartViewport ? '확대 구간' : ({
    '7d': '7일',
    '30d': '30일',
    '90d': '90일',
    '1y': '1년',
    all: '전체'
  }[videoViewChartRange] || '선택 기간');
  const observedSamples = videoViewChartViewport ? math.filterSamplesInTimeWindow(math.filterSamples(history.samples, videoViewChartRange, now), timeAxis.startTime, timeAxis.endTime) : math.filterSamples(history.samples, videoViewChartRange, now);
  const chart = buildDetailChart(
    samples,
    math.linearRegression(samples),
    timeAxis,
    [],
    null,
    displayMode,
    {
      metric, baseline: observedSamples[0]?.count,
      svgId: 'video-view-detail-svg',
      crosshairId: 'video-view-crosshair',
      dotId: 'video-view-hover-dot',
      tooltipId: 'video-view-tooltip',
      selectionId: 'video-view-selection',
      gradientId: 'video-view-chart-gradient',
      titleId: 'video-view-chart-title',
      descId: 'video-view-chart-desc',
      title: '영상 조회수 상세 추이',
      description: '선택한 기간의 실제 조회수 또는 첫 관측값 대비 증감을 나타냅니다.',
      selectionEnabled: false
    }
  );
  videoViewChartModel = {
    ...chart.model,
    baseSamples,
    fullTimeAxis: baseTimeAxis
  };
  resetZoomButton.hidden = !videoViewChartViewport;
  elements.videoViewDetailContent.innerHTML = `
    ${analysisOverview(observedSamples, '회')}
    <section class="analysis-plot-panel">
      ${analysisCaption(samples, metric, '회', displayMode)}
      ${chart.svg}
    </section>
    ${analysisDailyTable(videoViewChartViewport ? math.analyzeGrowthForTimeWindow(history.samples, timeAxis.startTime, timeAxis.endTime, now).daily : math.analyzeGrowthForRange(history.samples, videoViewChartRange, now).daily, '회')}
    `;
}

function renderDetailMetric(label, value, className = '') {
  return `
    <div class="detail-metric">
      <span>${escapeHtml(label)}</span>
      <strong class="${escapeAttribute(className)}">${escapeHtml(value)}</strong>
    </div>`;
}

function renderSelectionSummary(summary) {
  if (!summary) {
    return `
      <section class="selection-analysis empty" aria-label="선택 구간 분석 안내">
        <div>
          <strong>날짜 또는 구간 분석</strong>
          <span>위 차트에서 완료된 날짜를 클릭하거나 좌우로 드래그해 보세요.</span>
        </div>
      </section>`;
  }

  const rangeLabel = summary.startTime === summary.endTime
    ? formatSelectionDate(summary.startTime)
    : `${formatSelectionDate(summary.startTime)} – ${formatSelectionDate(summary.endTime)}`;
  const total = formatSignedAnalysis(summary.totalChange, '명', formatNumber);
  const averageChange = formatSignedAnalysis(summary.averageDailyChange, '명/일');
  const averageRate = formatSignedAnalysis(summary.averageGrowthRate, '%/일', formatPercent);
  const periodRate = formatSignedAnalysis(summary.periodGrowthRate, '%', formatPercent);
  const slope = formatSignedAnalysis(summary.slopePerDay, '명/일');

  return `
    <section class="selection-analysis" aria-labelledby="selection-analysis-title">
      <div class="selection-analysis-header">
        <div>
          <div class="eyebrow">SELECTED RANGE</div>
          <h3 id="selection-analysis-title">${escapeHtml(rangeLabel)}</h3>
          <span>완료일 ${summary.dayCount}개 기준</span>
        </div>
        <button type="button" data-clear-chart-selection>선택 해제</button>
      </div>
      <div class="selection-metrics">
        ${renderSelectionMetric('누적 증감', total)}
        ${renderSelectionMetric('일평균 증가량', averageChange)}
        ${renderSelectionMetric('일평균 성장률', averageRate)}
        ${renderSelectionMetric('구간 성장률', periodRate)}
        ${renderSelectionMetric('추세 기울기', slope)}
      </div>
    </section>`;
}

function renderSelectionMetric(label, metric) {
  return `
    <div class="selection-metric">
      <span>${escapeHtml(label)}</span>
      <strong class="${escapeAttribute(metric.className)}">${escapeHtml(metric.value)}</strong>
    </div>`;
}

function renderGrowthAnalysis(growth, chart) {
  const dailyChange = formatSignedAnalysis(growth.latestDailyChange, '명/일');
  const growthRate = formatSignedAnalysis(growth.latestGrowthRate, '%/일', formatPercent);
  const acceleration = formatChangeState(
    growth.accelerationChange,
    '가속',
    '둔화',
    '명/일 차이'
  );
  const momentum = formatChangeState(
    growth.momentumChange,
    '강화',
    '약화',
    '명/일'
  );
  const slope = formatChangeState(
    growth.slopeChange,
    '상승',
    '하락',
    '명/일'
  );
  const momentumDetail = growth.momentumChange === null
    ? '일간 변화 6개 필요'
    : `직전 3개 완료 구간 하루 평균 ${formatSignedAnalysis(growth.previousMomentum, '명/일').value} → 최근 3개 ${formatSignedAnalysis(growth.recentMomentum, '명/일').value}`;
  const slopeDetail = growth.slopeChange === null
    ? '일별 마감 기록 4개 필요'
    : `전반 ${formatSignedAnalysis(growth.earlierSlope, '명/일').value} → 후반 ${formatSignedAnalysis(growth.laterSlope, '명/일').value}`;

  const completedLabel = Number.isFinite(growth.latestCompletedAt)
    ? `${formatChartDate(growth.latestCompletedAt)} 마감 기준 · ${growth.daily.length}개 완료일`
    : '완료된 날짜 기록 없음';

  return `
    <section class="growth-analysis" aria-labelledby="growth-analysis-title">
      <div class="growth-analysis-header">
        <div>
          <div class="eyebrow">GROWTH SIGNALS</div>
          <h3 id="growth-analysis-title">성장 분석</h3>
        </div>
        <span>${escapeHtml(completedLabel)}</span>
      </div>
      <div class="growth-metrics">
        ${renderGrowthMetric('일일 증가량', dailyChange.value, dailyChange.className, '마지막 완료일의 하루 평균')}
        ${renderGrowthMetric('성장률 추이', growthRate.value, growthRate.className, '마지막 완료일의 일일 증가율')}
        ${renderGrowthMetric('직전 대비 속도', acceleration.value, acceleration.className, '최근 증가량 − 직전 증가량')}
        ${renderGrowthMetric('최근 3구간 변화', momentum.value, momentum.className, momentumDetail)}
        ${renderGrowthMetric('전후반 추세 차이', slope.value, slope.className, slopeDetail)}
      </div>
      <div class="growth-chart-legend">
        <strong>일별 증가량 · 성장률 추이</strong>
        <span><i class="legend-growth-bar"></i>증가량</span>
        <span><i class="legend-growth-rate"></i>성장률</span>
      </div>
      ${chart}
      <p class="growth-method">오늘은 집계가 끝나지 않았으므로 모든 성장 분석과 증가량 차트에서 제외합니다. 완료된 날짜별 마지막 측정값을 마감값으로 사용하고, 첫 표시일의 변화는 기간 밖 직전 마감값과 비교합니다. 측정일 사이가 비면 증가분을 경과 일수로 나눕니다. 둔화는 최근 두 완료 구간의 하루 증가량 차이, 모멘텀은 최근 3개 완료 구간과 그 직전 3개 완료 구간의 하루 평균 증가량, 기울기는 선택 기간 전반부와 후반부 추세를 비교합니다.</p>
    </section>`;
}

function renderGrowthMetric(label, value, className, detail) {
  return `
    <div class="growth-metric">
      <span>${escapeHtml(label)}</span>
      <strong class="${escapeAttribute(className)}">${escapeHtml(value)}</strong>
      <small title="${escapeAttribute(detail)}">${escapeHtml(detail)}</small>
    </div>`;
}

function formatSignedAnalysis(value, suffix, formatter = formatTrend) {
  if (!Number.isFinite(value)) return { value: '데이터 부족', className: '' };
  const rounded = Math.abs(value) < 1e-9 ? 0 : value;
  return {
    value: `${rounded > 0 ? '+' : ''}${formatter(rounded)}${suffix}`,
    className: rounded > 0 ? 'up' : rounded < 0 ? 'down' : ''
  };
}

function formatChangeState(value, positiveLabel, negativeLabel, suffix) {
  const formatted = formatSignedAnalysis(value, suffix);
  if (!Number.isFinite(value)) return formatted;
  const label = value > 0 ? positiveLabel : value < 0 ? negativeLabel : '변화 없음';
  return { ...formatted, value: `${label} ${formatted.value}` };
}

function buildGrowthChart(dailySamples, timeAxis) {
  const samples = dailySamples.filter((sample) => Number.isFinite(sample.dailyChange));
  if (!samples.length) {
    return `
      <div class="growth-chart-empty">
        일별 증가량 차트는 서로 다른 날짜의 기록이 2개 이상 모이면 표시됩니다.
      </div>`;
  }

  const width = 840;
  const height = 210;
  const plot = { left: 68, right: 58, top: 18, bottom: 40 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const startTime = timeAxis.startTime;
  const endTime = timeAxis.endTime;
  const timeRange = Math.max(1, endTime - startTime);
  const toX = (timestamp) => plot.left + ((timestamp - startTime) / timeRange) * plotWidth;

  const changes = samples.map((sample) => sample.dailyChange);
  const changeMin = Math.min(0, ...changes);
  const changeMax = Math.max(0, ...changes);
  const changePadding = Math.max(1, (changeMax - changeMin) * 0.12);
  const minChange = changeMin - changePadding;
  const maxChange = changeMax + changePadding;
  const changeRange = Math.max(1, maxChange - minChange);
  const toChangeY = (value) => plot.top + ((maxChange - value) / changeRange) * plotHeight;
  const zeroY = toChangeY(0);

  const rates = samples.map((sample) => sample.growthRate).filter(Number.isFinite);
  const rateMin = Math.min(0, ...rates);
  const rateMax = Math.max(0, ...rates);
  const ratePadding = Math.max(0.001, (rateMax - rateMin) * 0.12);
  const minRate = rateMin - ratePadding;
  const maxRate = rateMax + ratePadding;
  const rateRange = Math.max(0.001, maxRate - minRate);
  const toRateY = (value) => plot.top + ((maxRate - value) / rateRange) * plotHeight;
  const barWidth = Math.max(1, Math.min(20, plotWidth / Math.max(8, samples.length * 1.7)));

  const yTicks = Array.from({ length: 4 }, (_, index) => {
    const ratio = index / 3;
    const y = plot.top + ratio * plotHeight;
    const changeValue = maxChange - ratio * changeRange;
    const rateValue = maxRate - ratio * rateRange;
    return `
      <line class="detail-grid" x1="${plot.left}" y1="${y}" x2="${plot.left + plotWidth}" y2="${y}"/>
      <text class="detail-axis-label y" x="${plot.left - 10}" y="${y + 3}">${escapeHtml(formatTrend(changeValue))}</text>
      <text class="detail-axis-label growth-rate-axis" x="${plot.left + plotWidth + 10}" y="${y + 3}">${escapeHtml(formatPercent(rateValue))}%</text>`;
  }).join('');
  const xTicks = timeAxis.ticks.map((timestamp) => {
    const x = toX(timestamp);
    return `
      <line class="detail-tick" x1="${x}" y1="${plot.top + plotHeight}" x2="${x}" y2="${plot.top + plotHeight + 5}"/>
      <text class="detail-axis-label x" x="${x}" y="${height - 13}">${escapeHtml(formatChartDate(timestamp))}</text>`;
  }).join('');
  const bars = samples.map((sample) => {
    const x = Math.min(
      plot.left + plotWidth - barWidth,
      Math.max(plot.left, toX(sample.dayTimestamp) - barWidth / 2)
    );
    const valueY = toChangeY(sample.dailyChange);
    const y = Math.min(valueY, zeroY);
    const barHeight = Math.max(1, Math.abs(zeroY - valueY));
    const className = sample.dailyChange >= 0 ? 'up' : 'down';
    return `<rect class="growth-bar ${className}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="2"><title>${escapeHtml(formatChartDate(sample.dayTimestamp))}: ${escapeHtml(formatSignedAnalysis(sample.dailyChange, '명/일').value)}</title></rect>`;
  }).join('');
  const ratePoints = samples.filter((sample) => Number.isFinite(sample.growthRate)).map((sample) => ({
    x: toX(sample.dayTimestamp),
    y: toRateY(sample.growthRate),
    sample
  }));
  const rateLine = ratePoints.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const rateDots = ratePoints.map((point) => `<circle class="growth-rate-dot" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3"><title>${escapeHtml(formatChartDate(point.sample.dayTimestamp))}: ${escapeHtml(formatSignedAnalysis(point.sample.growthRate, '%/일', formatPercent).value)}</title></circle>`).join('');

  return `
    <div class="growth-chart-wrap">
      <svg id="subscriber-growth-svg" class="growth-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="일별 구독자 증가량과 성장률 추이">
        ${yTicks}
        ${xTicks}
        <line class="growth-zero-line" x1="${plot.left}" y1="${zeroY}" x2="${plot.left + plotWidth}" y2="${zeroY}"/>
        ${bars}
        <polyline class="growth-rate-line" points="${rateLine}"/>
        ${rateDots}
      </svg>
    </div>`;
}

function buildDetailChart(
  samples,
  trend,
  timeAxis,
  dailySamples = [],
  selection = null,
  displayMode = 'samples',
  options = {}
) {
  const svgId = options.svgId || 'subscriber-detail-svg';
  const crosshairId = options.crosshairId || 'detail-crosshair';
  const dotId = options.dotId || 'detail-hover-dot';
  const tooltipId = options.tooltipId || 'detail-chart-tooltip';
  const selectionId = options.selectionId || 'detail-selection';
  const gradientId = options.gradientId || 'detail-chart-gradient';
  const titleId = options.titleId || 'detail-chart-title';
  const descId = options.descId || 'detail-chart-desc';
  const width = 840;
  const height = window.innerHeight <= 740 ? 170 : 240;
  const plot = { left: 68, right: 18, top: 18, bottom: 44 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const metric = options.metric || 'total';
  const baseline = metric === 'change' ? (options.baseline ?? samples[0].count) : 0;
  const values = samples.map(sample => sample.count - baseline);
  const trendValues = [];
  const combined = values;
  const rawMin = Math.min(...combined);
  const rawMax = Math.max(...combined);
  const rawRange = rawMax - rawMin;
  const padding = Math.max(1, rawRange * 0.12, rawMax * 0.002);
  const minValue = metric === 'change' ? Math.min(0, rawMin - padding) : Math.max(0, rawMin - padding);
  const maxValue = metric === 'change' ? Math.max(0, rawMax + padding) : rawMax + padding;
  const valueRange = Math.max(1, maxValue - minValue);
  const startTime = timeAxis.startTime;
  const endTime = timeAxis.endTime;
  const timeRange = Math.max(1, endTime - startTime);
  const toX = (timestamp) => plot.left + ((timestamp - startTime) / timeRange) * plotWidth;
  const toY = (value) => plot.top + ((maxValue - value) / valueRange) * plotHeight;
  const points = samples.map((sample) => ({
    x: toX(sample.timestamp),
    y: toY(sample.count - baseline),
    sample
  }));
  const dayPoints = dailySamples.filter((sample) => {
    const nextDay = new Date(sample.dayTimestamp);
    nextDay.setDate(nextDay.getDate() + 1);
    return sample.dayTimestamp <= endTime && nextDay.getTime() > startTime;
  }).map((sample) => ({
    x: Math.min(plot.left + plotWidth, Math.max(plot.left, toX(sample.dayTimestamp))),
    sample
  }));
  const linePoints = points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const areaPoints = `${points[0].x},${plot.top + plotHeight} ${linePoints} ${points.at(-1).x},${plot.top + plotHeight}`;
  const trendPoints = samples.map((sample, index) => (
    `${toX(sample.timestamp).toFixed(2)},${toY(trendValues[index] ?? sample.count).toFixed(2)}`
  )).join(' ');
  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const y = plot.top + ratio * plotHeight;
    const value = maxValue - ratio * valueRange;
    return `
      <line class="detail-grid" x1="${plot.left}" y1="${y}" x2="${plot.left + plotWidth}" y2="${y}"/>
      <text class="detail-axis-label y" x="${plot.left - 10}" y="${y + 3}">${escapeHtml(formatCompact(value))}</text>`;
  }).join('');
  const xTicks = timeAxis.ticks.map((timestamp) => {
    const x = toX(timestamp);
    return `
      <line class="detail-tick" x1="${x}" y1="${plot.top + plotHeight}" x2="${x}" y2="${plot.top + plotHeight + 5}"/>
      <text class="detail-axis-label x" x="${x}" y="${height - 15}">${escapeHtml(formatChartDate(timestamp))}</text>`;
  }).join('');
  const pointDots = points.length <= 40
    ? points.map((point) => `<circle class="detail-point" cx="${point.x}" cy="${point.y}" r="2.5"/>`).join('')
    : '';
  const selectionMarkup = options.selectionEnabled === false
    ? ''
    : selection
      ? buildSelectionMarkup(selection, toX, endTime, plot, plotHeight, selectionId)
      : `<rect id="${escapeAttribute(selectionId)}" class="detail-selection hidden"/>`;

  return {
    model: { width, height, points, dayPoints, plot, timeAxis, displayMode, metric, baseline },
    svg: `
      <div class="detail-chart-wrap">
        <svg id="${escapeAttribute(svgId)}" class="detail-chart" tabindex="0" aria-keyshortcuts="ArrowLeft ArrowRight Home End" viewBox="0 0 ${width} ${height}"
          preserveAspectRatio="none" role="img" aria-labelledby="${escapeAttribute(titleId)} ${escapeAttribute(descId)}">
          <title id="${escapeAttribute(titleId)}">${escapeHtml(options.title || '구독자 수 상세 추이')}</title>
          <desc id="${escapeAttribute(descId)}">${escapeHtml(options.description || '선택한 기간의 실제 관측값 또는 첫 관측값 대비 증감을 나타냅니다.')}</desc>
          <defs>
            <linearGradient id="${escapeAttribute(gradientId)}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#38d995" stop-opacity="0.23"/>
              <stop offset="100%" stop-color="#38d995" stop-opacity="0"/>
            </linearGradient>
          </defs>
          ${yTicks}
          ${xTicks}
          <polygon class="detail-chart-area" fill="url(#${escapeAttribute(gradientId)})" points="${areaPoints}"/>
          ${metric === 'change' ? `<line class="analysis-zero-line" x1="${plot.left}" x2="${plot.left + plotWidth}" y1="${toY(0)}" y2="${toY(0)}"/>` : ''}
          <polyline class="detail-actual-line" points="${linePoints}"/>
          ${pointDots}
          ${selectionMarkup}
          <line id="${escapeAttribute(crosshairId)}" class="detail-crosshair hidden" y1="${plot.top}" y2="${plot.top + plotHeight}"/>
          <circle id="${escapeAttribute(dotId)}" class="detail-hover-dot hidden" r="5"/>
        </svg>
        <div id="${escapeAttribute(tooltipId)}" class="detail-chart-tooltip hidden"></div>
      </div>`
  };
}

function buildSelectionMarkup(selection, toX, endTime, plot, plotHeight, selectionId = 'detail-selection') {
  const startTime = Math.min(selection.startTime, selection.endTime);
  const selectedEnd = Math.max(selection.startTime, selection.endTime);
  const nextDay = new Date(selectedEnd);
  nextDay.setDate(nextDay.getDate() + 1);
  const x = Math.max(plot.left, toX(startTime));
  const endX = toX(Math.min(endTime, nextDay.getTime()));
  return `<rect id="${escapeAttribute(selectionId)}" class="detail-selection" x="${x.toFixed(2)}" y="${plot.top}" width="${Math.max(2, endX - x).toFixed(2)}" height="${plotHeight}" rx="4"/>`;
}

function handleDetailChartPointerDown(event) {
  const svg = event.target.closest?.('#subscriber-detail-svg');
  if (!svg || event.button !== 0 || !detailChartModel?.dayPoints?.length) return;
  const day = nearestSelectableDay(event, svg);
  if (!day) return;
  event.preventDefault();
  svg.setPointerCapture?.(event.pointerId);
  detailChartDrag = {
    pointerId: event.pointerId,
    anchorTime: day.sample.dayTimestamp,
    currentTime: day.sample.dayTimestamp
  };
  updateSelectionOverlay(detailChartDrag.anchorTime, detailChartDrag.currentTime);
  hideDetailChartTooltip();
}

function handleDetailChartPointerMove(event) {
  const svg = event.target.closest?.('#subscriber-detail-svg');
  if (!svg || !detailChartModel?.points?.length) return;
  if (detailChartDrag?.pointerId === event.pointerId) {
    const day = nearestSelectableDay(event, svg);
    if (day) {
      detailChartDrag.currentTime = day.sample.dayTimestamp;
      updateSelectionOverlay(detailChartDrag.anchorTime, detailChartDrag.currentTime);
    }
    event.preventDefault();
    return;
  }

  const bounds = svg.getBoundingClientRect();
  const viewX = ((event.clientX - bounds.left) / bounds.width) * detailChartModel.width;
  const point = window.LivePulseChartHover.nearest(detailChartModel.points, viewX);
  const crosshair = elements.subscriberDialog.querySelector('#detail-crosshair');
  const dot = elements.subscriberDialog.querySelector('#detail-hover-dot');
  const tooltip = elements.subscriberDialog.querySelector('#detail-chart-tooltip');
  if (!crosshair || !dot || !tooltip) return;

  crosshair.setAttribute('x1', point.x);
  crosshair.setAttribute('x2', point.x);
  dot.setAttribute('cx', point.x);
  dot.setAttribute('cy', point.y);
  crosshair.classList.remove('hidden');
  dot.classList.remove('hidden');
  tooltip.classList.remove('hidden');
  tooltip.innerHTML = `
    <strong>${detailChartModel.metric === 'change' ? analysisNumber(point.sample.count - detailChartModel.baseline, '명') : `${escapeHtml(formatNumber(point.sample.count))}명`}</strong>
    ${detailChartModel.metric === 'change' ? `<span>전체 ${formatNumber(point.sample.count)}명</span>` : ''}
    <span>${escapeHtml(detailChartModel.displayMode === 'daily'
      ? formatSelectionDate(point.sample.timestamp)
      : formatChartDateTime(point.sample.timestamp))}</span>`;
  const pixelX = (point.x / detailChartModel.width) * bounds.width;
  const pixelY = (point.y / detailChartModel.height) * bounds.height;
  tooltip.style.left = `${Math.min(bounds.width - 84, Math.max(84, pixelX))}px`;
  tooltip.style.top = `${Math.max(8, pixelY - 62)}px`;
}

function handleDetailChartPointerUp(event) {
  if (!detailChartDrag || detailChartDrag.pointerId !== event.pointerId) return;
  const svg = event.target.closest?.('#subscriber-detail-svg')
    || elements.subscriberDialog.querySelector('#subscriber-detail-svg');
  const day = svg ? nearestSelectableDay(event, svg) : null;
  const endTime = day?.sample.dayTimestamp ?? detailChartDrag.currentTime;
  subscriberChartSelection = {
    startTime: Math.min(detailChartDrag.anchorTime, endTime),
    endTime: Math.max(detailChartDrag.anchorTime, endTime)
  };
  try {
    svg?.releasePointerCapture?.(event.pointerId);
  } catch {
    // Pointer capture may already have been released by the browser.
  }
  detailChartDrag = null;
  renderSubscriberDetail();
}

function handleDetailChartPointerCancel(event) {
  if (!detailChartDrag || detailChartDrag.pointerId !== event.pointerId) return;
  detailChartDrag = null;
  renderSubscriberDetail();
}

function handleDetailChartWheel(event) {
  const svg = event.target.closest?.('#subscriber-detail-svg, #subscriber-growth-svg');
  const model = detailChartModel;
  if (!svg || !model?.points?.length || !model?.fullTimeAxis || !event.deltaY) return;
  const bounds = svg.getBoundingClientRect();
  if (!bounds.width) return;

  event.preventDefault();
  const plotRight = svg.id === 'subscriber-growth-svg' ? 58 : model.plot.right;
  const plotWidth = model.width - model.plot.left - plotRight;
  const viewX = ((event.clientX - bounds.left) / bounds.width) * model.width;
  const anchorRatio = Math.min(1, Math.max(0, (viewX - model.plot.left) / plotWidth));
  const currentWindow = subscriberChartViewport || model.fullTimeAxis;
  const anchorTime = currentWindow.startTime
    + (currentWindow.endTime - currentWindow.startTime) * anchorRatio;
  const nextWindow = window.LivePulseChartMath.zoomTimeWindow(
    currentWindow,
    model.fullTimeAxis,
    anchorTime,
    event.deltaY < 0 ? 0.8 : 1.25,
    CHART_MINIMUM_SPAN_MS
  );
  if (!nextWindow || isSameTimeWindow(nextWindow, currentWindow)) return;

  const nextSamples = window.LivePulseChartMath.filterSamplesInTimeWindow(
    model.baseSamples,
    nextWindow.startTime,
    nextWindow.endTime
  );
  if (!nextSamples.length) return;
  subscriberChartViewport = isSameTimeWindow(nextWindow, model.fullTimeAxis) ? null : nextWindow;
  subscriberChartSelection = null;
  detailChartDrag = null;
  hideDetailChartTooltip();
  renderSubscriberDetail();
}

function handleVideoViewPointerMove(event) {
  const svg = event.target.closest?.('#video-view-detail-svg');
  const model = videoViewChartModel;
  if (!svg || !model?.points?.length) return;
  const bounds = svg.getBoundingClientRect();
  if (!bounds.width) return;
  const viewX = ((event.clientX - bounds.left) / bounds.width) * model.width;
  const point = window.LivePulseChartHover.nearest(model.points, viewX);
  const crosshair = elements.videoViewDialog.querySelector('#video-view-crosshair');
  const dot = elements.videoViewDialog.querySelector('#video-view-hover-dot');
  const tooltip = elements.videoViewDialog.querySelector('#video-view-tooltip');
  if (!crosshair || !dot || !tooltip) return;

  crosshair.setAttribute('x1', point.x);
  crosshair.setAttribute('x2', point.x);
  dot.setAttribute('cx', point.x);
  dot.setAttribute('cy', point.y);
  crosshair.classList.remove('hidden');
  dot.classList.remove('hidden');
  tooltip.classList.remove('hidden');
  tooltip.innerHTML = `
    <strong>${model.metric === 'change' ? analysisNumber(point.sample.count - model.baseline, '회') : `${escapeHtml(formatNumber(point.sample.count))}회`}</strong>
    ${model.metric === 'change' ? `<span>누적 ${formatNumber(point.sample.count)}회</span>` : ''}
    <span>${escapeHtml(formatChartDateTime(point.sample.timestamp))}</span>`;
  const pixelX = (point.x / model.width) * bounds.width;
  const pixelY = (point.y / model.height) * bounds.height;
  tooltip.style.left = `${Math.min(bounds.width - 84, Math.max(84, pixelX))}px`;
  tooltip.style.top = `${Math.max(8, pixelY - 62)}px`;
}

function handleVideoViewWheel(event) {
  const svg = event.target.closest?.('#video-view-detail-svg');
  const model = videoViewChartModel;
  if (!svg || !model?.points?.length || !model?.fullTimeAxis || !event.deltaY) return;
  const bounds = svg.getBoundingClientRect();
  if (!bounds.width) return;

  event.preventDefault();
  const plotWidth = model.width - model.plot.left - model.plot.right;
  const viewX = ((event.clientX - bounds.left) / bounds.width) * model.width;
  const anchorRatio = Math.min(1, Math.max(0, (viewX - model.plot.left) / plotWidth));
  const currentWindow = videoViewChartViewport || model.fullTimeAxis;
  const anchorTime = currentWindow.startTime
    + (currentWindow.endTime - currentWindow.startTime) * anchorRatio;
  const nextWindow = window.LivePulseChartMath.zoomTimeWindow(
    currentWindow,
    model.fullTimeAxis,
    anchorTime,
    event.deltaY < 0 ? 0.8 : 1.25,
    CHART_MINIMUM_SPAN_MS
  );
  if (!nextWindow || isSameTimeWindow(nextWindow, currentWindow)) return;
  const nextSamples = window.LivePulseChartMath.filterSamplesInTimeWindow(
    model.baseSamples,
    nextWindow.startTime,
    nextWindow.endTime
  );
  if (!nextSamples.length) return;
  videoViewChartViewport = isSameTimeWindow(nextWindow, model.fullTimeAxis) ? null : nextWindow;
  hideVideoViewTooltip();
  renderVideoViewDetail();
}

function hideVideoViewTooltip() {
  hoverFrames.clear('video');
  elements.videoViewDialog.querySelector('#video-view-crosshair')?.classList.add('hidden');
  elements.videoViewDialog.querySelector('#video-view-hover-dot')?.classList.add('hidden');
  elements.videoViewDialog.querySelector('#video-view-tooltip')?.classList.add('hidden');
}

function isSameTimeWindow(left, right) {
  return Boolean(left && right
    && Math.abs(left.startTime - right.startTime) < 1
    && Math.abs(left.endTime - right.endTime) < 1);
}

function nearestSelectableDay(event, svg) {
  if (!detailChartModel?.dayPoints?.length) return null;
  const bounds = svg.getBoundingClientRect();
  if (!bounds.width) return null;
  const viewX = ((event.clientX - bounds.left) / bounds.width) * detailChartModel.width;
  return detailChartModel.dayPoints.reduce((nearest, candidate) => (
    Math.abs(candidate.x - viewX) < Math.abs(nearest.x - viewX) ? candidate : nearest
  ));
}

function updateSelectionOverlay(firstTime, secondTime) {
  const selection = elements.subscriberDialog.querySelector('#detail-selection');
  const model = detailChartModel;
  if (!selection || !model?.plot || !model?.timeAxis) return;
  const startTime = Math.min(firstTime, secondTime);
  const endTime = Math.max(firstTime, secondTime);
  const nextDay = new Date(endTime);
  nextDay.setDate(nextDay.getDate() + 1);
  const plotWidth = model.width - model.plot.left - model.plot.right;
  const timeRange = Math.max(1, model.timeAxis.endTime - model.timeAxis.startTime);
  const toX = (timestamp) => model.plot.left
    + ((timestamp - model.timeAxis.startTime) / timeRange) * plotWidth;
  const x = Math.max(model.plot.left, toX(startTime));
  const endX = Math.min(
    model.plot.left + plotWidth,
    toX(Math.min(model.timeAxis.endTime, nextDay.getTime()))
  );
  selection.setAttribute('x', x.toFixed(2));
  selection.setAttribute('y', model.plot.top);
  selection.setAttribute('width', Math.max(2, endX - x).toFixed(2));
  selection.setAttribute('height', model.height - model.plot.top - model.plot.bottom);
  selection.setAttribute('rx', '4');
  selection.classList.remove('hidden');
}

function hideDetailChartTooltip() {
  hoverFrames.clear('subscriber');
  elements.subscriberDialog.querySelector('#detail-crosshair')?.classList.add('hidden');
  elements.subscriberDialog.querySelector('#detail-hover-dot')?.classList.add('hidden');
  elements.subscriberDialog.querySelector('#detail-chart-tooltip')?.classList.add('hidden');
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
  elements.settingSubscriberChartMode.value = readChartPreferences().subscriberMode;
  elements.settingInterval.value = settings.pollIntervalSeconds;
  elements.settingApiKey.value = '';
  elements.settingCloudUrl.value = settings.cloudUrl || '';
  elements.settingCloudToken.value = '';
  elements.settingCloudToken.placeholder = settings.hasCloudToken ? '저장된 연결 키 유지' : '새로 연결할 때 입력';
  elements.cloudSyncStatus.textContent = appState.cloud?.error || (settings.cloudUrl
    ? (appState.cloud?.lastSyncAt ? `최근 동기화: ${new Date(appState.cloud.lastSyncAt).toLocaleString('ko-KR')}` : '연결 후 동기화를 기다립니다.')
    : '클라우드 연결 안 됨');
  elements.settingApiKey.placeholder = settings.hasApiKey
    ? '저장된 키 유지 (변경할 때만 입력)'
    : '입력하지 않아도 작동합니다';
  elements.apiKeyStatus.textContent = settings.hasApiKey
    ? 'API 키 저장됨 · 공식 채널·영상 통계를 사용합니다. 구독자 수는 공개 정책상 반올림됩니다.'
    : 'API 키 없음 · 공개 페이지로 영상 감지와 조회수 수집을 계속합니다.';
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
    subscriberChartMode: elements.settingSubscriberChartMode.value,
    pollIntervalSeconds: Number(elements.settingInterval.value),
    cloudUrl: elements.settingCloudUrl.value.trim()
  };
  if (elements.settingApiKey.value.trim()) update.apiKey = elements.settingApiKey.value.trim();
  if (elements.settingCloudToken.value.trim()) update.cloudToken = elements.settingCloudToken.value.trim();

  await safely(async () => {
    appState = await window.livePulse.updateSettings(update);
    saveChartPreference('subscriberMode', update.subscriberChartMode);
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
    elements.apiKeyStatus.textContent = 'API 키 없음 · 공개 페이지로 영상 감지와 조회수 수집을 계속합니다.';
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
  return cachedFormatter('NumberFormat', {
    notation: 'compact',
    maximumFractionDigits: 2
  }).format(numeric);
}

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return cachedFormatter('NumberFormat', { maximumFractionDigits: 0 }).format(Math.round(numeric));
}

function formatTrend(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  const absolute = Math.abs(numeric);
  const maximumFractionDigits = absolute < 1 ? 2 : absolute < 10 ? 1 : 0;
  return cachedFormatter('NumberFormat', { maximumFractionDigits }).format(numeric);
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  const absolute = Math.abs(numeric);
  const maximumFractionDigits = absolute < 0.01 ? 3 : absolute < 1 ? 2 : 1;
  return cachedFormatter('NumberFormat', { maximumFractionDigits }).format(numeric);
}

function formatChartDate(value) {
  return cachedFormatter('DateTimeFormat', {
    month: 'short',
    day: 'numeric'
  }).format(value);
}

function formatSelectionDate(value) {
  return cachedFormatter('DateTimeFormat', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(value);
}

function formatChartDateTime(value) {
  return cachedFormatter('DateTimeFormat', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value);
}

function formatRelativeTime(value) {
  if (!value) return '';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return String(value);
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = cachedFormatter('RelativeTimeFormat', { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, 'day');
  return cachedFormatter('DateTimeFormat', { month: 'short', day: 'numeric' }).format(timestamp);
}

function formatSchedule(value) {
  if (!value) return '시간 미정';
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return '시간 미정';
  return cachedFormatter('DateTimeFormat', {
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

function readChartPreferences() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem('live-pulse:chart-preferences') || '{}'); } catch { saved = chartPreferencesMemory || {}; }
  if (!saved?.subscriberMode && typeof appState !== 'undefined') saved = {...saved, subscriberMode: appState?.settings?.subscriberChartMode};
  return window.LivePulseAnalytics.preferences(saved);
}
function saveChartPreference(key, value) {
  const prefs = window.LivePulseAnalytics.preferences({...readChartPreferences(), [key]: value});
  chartPreferencesMemory = prefs;
  try { localStorage.setItem('live-pulse:chart-preferences', JSON.stringify(prefs)); } catch { /* Keep the current session preference. */ }
}
