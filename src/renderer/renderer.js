'use strict';

let appState = null;
let windowActive = true;
let analyticsRequest = 0;
let analyticsRequestPending = false;
async function requestAnalytics(scope) {
  if (!appState?.analyticsLazy) return true;
  const request = ++analyticsRequest;
  analyticsRequestPending = true;
  try {
    const state = await window.livePulse.watchAnalytics(scope);
    if (request !== analyticsRequest) return false;
    appState = state;
    return true;
  } catch (error) { if (request === analyticsRequest) showError(cleanError(error)); return false; }
  finally { if (request === analyticsRequest) analyticsRequestPending = false; }
}
async function releaseAnalytics() {
  if (!appState?.analyticsLazy || analyticsRequestPending || document.querySelector('dialog[open]')) return;
  if (await requestAnalytics({subscriberId: null, videos: []})) render();
}
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
  window.livePulse.onWindowActive?.(active => {
    windowActive = active;
    clearInterval(countdownTimer); countdownTimer = null;
    if (active) { countdownTimer = setInterval(renderMonitorStatus, 1000); render(); }
    else clearTimeout(chartRefreshTimer);
  });
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
    windowActive = appState.app?.windowActive !== false;
    render();
    const smokeParams = new URLSearchParams(window.location.search);
    if (smokeParams.has('smokeChart') && appState.channels[0]) {
      await openSubscriberChart(
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
        await openVideoViewChart(appState.channels[0].id, history.videoId);
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

  clearInterval(countdownTimer);
  if (windowActive) countdownTimer = window.setInterval(renderMonitorStatus, 1000);
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
    'setting-posts', 'setting-local-stats', 'local-stats-help', 'setting-subscriber-chart-mode', 'setting-interval',
    'setting-api-key', 'api-key-status',
    'setting-cloud-url', 'setting-cloud-token', 'cloud-sync-status',
    'import-cloud-connection', 'setting-backup-folder', 'backup-folder-status', 'choose-backup-folder',
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
    void releaseAnalytics();
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
    void releaseAnalytics();
  });
  elements.videoViewSelect.addEventListener('change', async () => {
    const videoId = elements.videoViewSelect.value;
    if (appState?.analyticsLazy && !await requestAnalytics({subscriberId: null, videos: [{channelId: videoViewChartChannelId, videoId}]})) return;
    videoViewChartVideoId = videoId;
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
  elements.chooseBackupFolder.addEventListener('click', () => safely(async () => {
    const result = await window.livePulse.chooseBackupFolder();
    if (!result.canceled) elements.settingBackupFolder.value = result.path;
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
      if (window.confirm(`"${channel?.title || '이 채널'}"을 삭제할까요? 이 PC에 저장된 구독자·조회수 기록과 알림도 함께 지워지며 되돌릴 수 없어요.`)) {
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
  if (!appState || !windowActive) return;
  elements.appVersion.textContent = appState.app?.nativePersonal
    ? '개인용 빌드' : (appState.app?.version ? `v${appState.app.version}` : '');
  const update = appState.app?.update;
  elements.updateStatus.textContent = update?.message || '업데이트 확인 대기 중';
  elements.updateButton.textContent = appState.app?.nativePersonal ? '업데이트 수동 적용'
    : update?.status === 'downloading'
    ? `업데이트 ${update.percent || 0}%`
    : '앱 업데이트 확인';
  elements.updateButton.disabled = appState.app?.nativePersonal || ['checking', 'downloading'].includes(update?.status);
  // The portable build updates by rebuilding; an always-disabled button only confused users.
  elements.updateButton.hidden = Boolean(appState.app?.nativePersonal);
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
  const warning = monitor.warning || '';

  elements.globalLivePill.classList.toggle('live', liveChannels.length > 0);
  elements.globalLivePill.innerHTML = liveChannels.length
    ? `<span class="status-dot"></span><span>${liveChannels.length}개 채널 LIVE</span>`
    : '<span class="status-dot"></span><span>라이브 없음</span>';

  elements.sidebarDot.className = `status-dot ${hasError || warning ? 'warning' : 'pulse'}`;
  elements.sidebarStatusText.textContent = monitor.running
    ? '지금 확인 중'
    : hasError ? '일부 확인 실패' : warning ? '확인 필요' : '백그라운드 감시 중';
  elements.sidebarStatusText.title = warning;

  if (warning && !monitor.running) {
    elements.sidebarNextCheck.textContent = warning;
  } else if (monitor.running) {
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
  // Prefer the latest recorded count (cloud every minute); a missing page count is not zero.
  const recorded = latestSample ? Number(latestSample.count) : NaN;
  const listed = video.viewCount === null || video.viewCount === undefined || video.viewCount === ''
    ? NaN : Number(video.viewCount);
  const viewCount = Number.isFinite(recorded) ? recorded : listed;
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
  // The card always shows daily closes: while a detail chart is open this channel carries its
  // full minute-level history, and "the last 60 samples" would briefly draw a flat last hour.
  const samples = math.collapseSamplesByLocalDate(allSamples).slice(-60);
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

// Open the dialog at once with a placeholder; the full history arrives from the host afterwards.
function showDetailLoading(dialog, titleElement, content, title) {
  titleElement.textContent = title || 'YouTube 채널';
  content.innerHTML = '<div class="empty-state"><strong>차트를 불러오는 중…</strong></div>';
  if (!dialog.open) dialog.showModal();
}

async function openSubscriberChart(channelId, initialRange = readChartPreferences().subscriberRange, selectSmokeRange = false) {
  if (appState?.analyticsLazy) {
    const current = appState.channels.find((item) => item.id === channelId);
    if (!elements.subscriberDialog.open) {
      showDetailLoading(elements.subscriberDialog, elements.subscriberDialogTitle, elements.subscriberDetailContent,
        current?.snapshot?.metadata?.title || current?.title);
    }
    if (!await requestAnalytics({subscriberId: channelId, videos: []})) {
      // A failed request leaves no data to show; a superseded one is handled by the newer request.
      if (!analyticsRequestPending && elements.subscriberDialog.open) elements.subscriberDialog.close();
      return;
    }
    if (!elements.subscriberDialog.open) return; // closed while loading
  }
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

async function openVideoViewChart(channelId, videoId) {
  if (appState?.analyticsLazy) {
    const current = appState.channels.find((item) => item.id === channelId)
      ?.videoViewHistories?.find((item) => item.videoId === videoId);
    if (!elements.videoViewDialog.open) {
      showDetailLoading(elements.videoViewDialog, elements.videoViewDialogTitle, elements.videoViewDetailContent,
        current?.title);
    }
    if (!await requestAnalytics({subscriberId: null, videos: [{channelId, videoId}]})) {
      // A failed request leaves no data to show; a superseded one is handled by the newer request.
      if (!analyticsRequestPending && elements.videoViewDialog.open) elements.videoViewDialog.close();
      return;
    }
    if (!elements.videoViewDialog.open) return; // closed while loading
  }
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
  document.getElementById('subscriber-chart-mode').value = displayMode;
  const displayHistory = displayMode === 'daily'
    ? math.collapseSamplesByLocalDate(channel.subscriberHistory || [])
    : channel.subscriberHistory || [];
  const baseSamples = math.filterSamples(displayHistory, subscriberChartRange, now);
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

  const outlook = window.LivePulseAnalytics.forecast(channel.subscriberHistory || [], 'subscriber', now);
  const baseTimeAxis = forecastAxis(math.buildTimeAxis(baseSamples, subscriberChartRange, now), outlook);
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
  // A window inside the forecast area has no observations; keep the adjacent real points.
  if (!samples.length) samples = math.plotSamples(baseSamples, subscriberChartViewport.startTime, subscriberChartViewport.endTime);
  const timeAxis = subscriberChartViewport
    ? math.buildTimeWindowAxis(
      subscriberChartViewport.startTime,
      subscriberChartViewport.endTime
    )
    : baseTimeAxis;
  const resetZoomButton = elements.subscriberDialog.querySelector('[data-reset-chart-zoom]');
  resetZoomButton.hidden = !subscriberChartViewport;

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
  const chart = buildMarketChart(samples, timeAxis, growth.daily, subscriberChartSelection, displayMode, {
    unit: '명', title: '구독자 수 추이', size: marketChartSize(elements.subscriberDetailContent),
    forecast: outlook, domainEnd: baseTimeAxis.endTime,
    plotSamples: math.plotSamples(baseSamples, timeAxis.startTime, timeAxis.endTime), domainSamples: baseSamples
  });
  detailChartModel = {
    ...chart.model,
    baseSamples,
    fullTimeAxis: baseTimeAxis,
    defaultReadout: marketDefaultReadout(samples.at(-1), '명', displayMode, true)
  };
  document.getElementById('subscriber-ticker').innerHTML = analysisTicker(channel.subscriberHistory, '명', now);
  elements.subscriberDetailContent.innerHTML = `
    <div class="market-layout">
      <section class="analysis-plot-panel">
        ${chart.svg}
        ${renderSelectionSummary(selectionSummary)}
      </section>
      ${analysisOutlook(outlook, '명')}
    </div>
    ${analysisDailyTable(growth.daily, '명', [subscriberChartChannelId, subscriberChartRange, displayMode, subscriberChartViewport])}
    `;
  restoreMarketHover(elements.subscriberDialog, detailChartModel, SUBSCRIBER_CHART_IDS);
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
  const outlook = window.LivePulseAnalytics.forecast(history.samples, 'video', now);
  const baseTimeAxis = forecastAxis(math.buildTimeAxis(baseSamples, videoViewChartRange, lastSampleTime), outlook);
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
  if (!samples.length) samples = math.plotSamples(baseSamples, videoViewChartViewport.startTime, videoViewChartViewport.endTime);
  const timeAxis = videoViewChartViewport
    ? math.buildTimeWindowAxis(videoViewChartViewport.startTime, videoViewChartViewport.endTime)
    : baseTimeAxis;
  const daily = videoViewChartViewport
    ? math.analyzeGrowthForTimeWindow(history.samples, timeAxis.startTime, timeAxis.endTime, now).daily
    : math.analyzeGrowthForRange(history.samples, videoViewChartRange, now).daily;
  const chart = buildMarketChart(samples, timeAxis, daily, null, displayMode, {
    unit: '회', title: '영상 조회수 추이', ids: VIDEO_CHART_IDS, selectionEnabled: false,
    size: marketChartSize(elements.videoViewDetailContent),
    forecast: outlook, domainEnd: baseTimeAxis.endTime,
    plotSamples: math.plotSamples(baseSamples, timeAxis.startTime, timeAxis.endTime), domainSamples: baseSamples
  });
  videoViewChartModel = {
    ...chart.model,
    baseSamples,
    fullTimeAxis: baseTimeAxis,
    defaultReadout: marketDefaultReadout(samples.at(-1), '회', displayMode, false)
  };
  resetZoomButton.hidden = !videoViewChartViewport;
  document.getElementById('video-ticker').innerHTML = analysisTicker(history.samples, '회', now);
  elements.videoViewDetailContent.innerHTML = `
    <div class="market-layout">
      <section class="analysis-plot-panel">${chart.svg}</section>
      ${analysisOutlook(outlook, '회')}
    </div>
    ${analysisDailyTable(daily, '회', [videoViewChartChannelId, videoViewChartVideoId, videoViewChartRange, displayMode, videoViewChartViewport])}
    `;
  restoreMarketHover(elements.videoViewDialog, videoViewChartModel, VIDEO_CHART_IDS);
}

function renderSelectionSummary(summary) {
  if (!summary) return '';
  const rangeLabel = summary.startTime === summary.endTime
    ? formatSelectionDate(summary.startTime)
    : `${formatSelectionDate(summary.startTime)} – ${formatSelectionDate(summary.endTime)}`;
  return `
    <section class="selection-analysis" aria-labelledby="selection-analysis-title">
      <h3 id="selection-analysis-title">${escapeHtml(rangeLabel)} <small>완료일 ${summary.dayCount}개</small></h3>
      ${renderSelectionMetric('누적 증감', formatSignedAnalysis(summary.totalChange, '명', formatNumber))}
      ${renderSelectionMetric('하루 평균', formatSignedAnalysis(summary.averageDailyChange, '명/일'))}
      ${renderSelectionMetric('구간 성장률', formatSignedAnalysis(summary.periodGrowthRate, '%', formatPercent))}
      <button type="button" data-clear-chart-selection>선택 해제</button>
    </section>`;
}

function renderSelectionMetric(label, metric) {
  return `
    <div class="selection-metric">
      <span>${escapeHtml(label)}</span>
      <strong class="${escapeAttribute(metric.className)}">${escapeHtml(metric.value)}</strong>
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

const DAY_MS = 24 * 60 * 60 * 1000;
const SUBSCRIBER_CHART_IDS = {svg: 'subscriber-detail-svg', crosshair: 'detail-crosshair', dot: 'detail-hover-dot',
  readout: 'detail-chart-tooltip', selection: 'detail-selection'};
const VIDEO_CHART_IDS = {svg: 'video-view-detail-svg', crosshair: 'video-view-crosshair', dot: 'video-view-hover-dot',
  readout: 'video-view-tooltip', selection: 'video-view-selection'};

// The drawn and zoomable axis: the data range plus a forecast horizon of a quarter of it (2-60 days).
// Zoom works on this same axis, so the date under the cursor stays put while zooming.
function forecastAxis(axis, forecast) {
  if (!forecast?.ready) return axis;
  const horizon = Math.max(2, Math.min(60, Math.round((axis.endTime - axis.startTime) / DAY_MS * 0.25)));
  return window.LivePulseChartMath.buildTimeWindowAxis(axis.startTime,
    Math.max(axis.endTime, forecast.anchor.timestamp + horizon * DAY_MS));
}

// Pixel-sized viewBox so labels are never stretched; the side panel sits beside wide charts.
function marketChartSize(content) {
  const available = Math.max(0, (content?.clientWidth || 1000) - 34);
  const width = Math.max(520, Math.round(available >= 900 ? available - 296 : available));
  const compact = window.innerHeight <= 740;
  const height = Math.round(Math.max(220, Math.min(480, window.innerHeight - (compact ? 350 : 380))));
  return {width, height};
}

function niceTicks(low, high, count = 4) {
  const span = Math.max(1e-9, high - low);
  const raw = span / count, power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(n => n * power).find(n => n >= raw) || raw;
  const ticks = [];
  for (let value = Math.ceil(low / step) * step; value <= high + step * 1e-6; value += step) ticks.push(value);
  return ticks;
}

// Stock-style chart: value pane with a right price axis and last-value tag, a daily-gain pane
// below it (like volume) with a 7-day average, and an optional dashed forecast band after the
// latest observation. Forecast values are drawn only; they are never treated as observations.
function buildMarketChart(samples, timeAxis, dailySamples = [], selection = null, displayMode = 'samples', options = {}) {
  const ids = options.ids || SUBSCRIBER_CHART_IDS;
  const unit = options.unit || '명';
  const {width, height} = options.size || {width: 840, height: 300};
  const forecast = options.forecast?.ready ? options.forecast : null;
  const anchor = forecast?.anchor;
  const axis = timeAxis;
  const showForecast = forecast && axis.endTime > anchor.timestamp;
  const plot = {left: 12, right: 78, top: 14};
  const axisHeight = 26, gap = 22;
  const volumeHeight = Math.max(44, Math.round(height * 0.2));
  const mainBottom = height - axisHeight - volumeHeight - gap;
  const volumeTop = mainBottom + gap, volumeBottom = height - axisHeight;
  plot.bottom = height - mainBottom;
  const plotWidth = width - plot.left - plot.right;
  const plotRight = plot.left + plotWidth;
  const toX = time => plot.left + (time - axis.startTime) / Math.max(1, axis.endTime - axis.startTime) * plotWidth;

  const projection = [];
  if (showForecast) {
    const from = Math.max(0, (axis.startTime - anchor.timestamp) / DAY_MS), days = (axis.endTime - anchor.timestamp) / DAY_MS;
    for (let i = 0; i <= 32; i++) {
      const at = from + (days - from) * i / 32;
      projection.push({timestamp: anchor.timestamp + at * DAY_MS, ...forecast.project(at)});
    }
  }
  // The band may be wide; scale for the data and the projected center, and clip the band instead.
  // Keep the preset Y domain while zooming: it always spans the whole horizon's projected center.
  const domainValues = (options.domainSamples || samples).map(sample => sample.count)
    .concat(forecast && options.domainEnd > anchor.timestamp ? [forecast.project((options.domainEnd - anchor.timestamp) / DAY_MS).value] : []);
  const rawLow = Math.min(...domainValues), rawHigh = Math.max(...domainValues);
  const pad = Math.max(1, (rawHigh - rawLow) * 0.08, rawHigh * 0.001);
  const low = Math.max(0, rawLow - pad), high = rawHigh + pad;
  const toY = value => plot.top + (high - value) / Math.max(1, high - low) * (mainBottom - plot.top);

  const points = samples.map(sample => ({x: toX(sample.timestamp), y: toY(sample.count), sample}));
  const line = (options.plotSamples || samples).map(sample => `${toX(sample.timestamp).toFixed(1)},${toY(sample.count).toFixed(1)}`);
  const first = (options.plotSamples || samples)[0], last = samples.at(-1);
  const direction = last.count >= (options.domainSamples || samples)[0].count ? 'up' : 'down';
  const area = `${toX(first.timestamp).toFixed(1)},${mainBottom} ${line.join(' ')} ${toX((options.plotSamples || samples).at(-1).timestamp).toFixed(1)},${mainBottom}`;

  const valueTicks = niceTicks(low, high, height < 280 ? 3 : 4).map(value => `
    <line class="market-grid" x1="${plot.left}" x2="${plotRight}" y1="${toY(value).toFixed(1)}" y2="${toY(value).toFixed(1)}"/>
    <text class="market-axis" x="${plotRight + 8}" y="${(toY(value) + 4).toFixed(1)}">${escapeHtml(formatCompact(value))}</text>`).join('');
  const timeTicks = window.LivePulseChartMath.detailTicks(axis, displayMode, plotWidth).map(tick => {
    const x = toX(tick.time);
    const label = tick.major ? formatChartDate(tick.time) : new Date(tick.time).getHours() + '시';
    return `<line class="market-grid ${tick.major ? 'market-day' : ''}" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${plot.top}" y2="${volumeBottom}"/>
      ${tick.major || tick.label ? `<text class="market-axis ${tick.major ? 'market-day-label' : ''}" x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle">${escapeHtml(label)}</text>` : ''}`;
  }).join('');

  // Daily gains of completed days, centered on their date, with the 7-day average line.
  const visibleDays = dailySamples.filter(day => Number.isFinite(day.dailyChange)
    && day.dayTimestamp + DAY_MS > axis.startTime && day.dayTimestamp <= axis.endTime);
  const average = visibleDays.map(day => {
    const recent = dailySamples.filter(other => Number.isFinite(other.dailyChange)
      && other.dayTimestamp > day.dayTimestamp - 7 * DAY_MS && other.dayTimestamp <= day.dayTimestamp);
    return recent.reduce((sum, other) => sum + other.dailyChange, 0) / recent.length;
  });
  const gains = visibleDays.map(day => day.dailyChange).concat(average);
  const gainHigh = Math.max(1, ...gains), gainLow = Math.min(0, ...gains);
  const toGainY = value => volumeTop + (gainHigh - value) / (gainHigh - gainLow) * (volumeBottom - volumeTop);
  const dayWidth = DAY_MS / Math.max(1, axis.endTime - axis.startTime) * plotWidth;
  const barWidth = Math.max(1.5, Math.min(26, dayWidth * 0.66));
  const bars = visibleDays.map(day => {
    const x = toX(day.dayTimestamp + DAY_MS / 2), top = Math.min(toGainY(day.dailyChange), toGainY(0));
    return `<rect class="market-bar ${day.dailyChange < 0 ? 'down' : 'up'}" x="${(x - barWidth / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(1, Math.abs(toGainY(day.dailyChange) - toGainY(0))).toFixed(1)}"/>`;
  }).join('');
  const averageLine = average.length > 1
    ? `<polyline class="market-average" points="${visibleDays.map((day, i) => `${toX(day.dayTimestamp + DAY_MS / 2).toFixed(1)},${toGainY(average[i]).toFixed(1)}`).join(' ')}"/>`
    : '';

  let forecastMarkup = '';
  if (showForecast) {
    const startX = Math.max(plot.left, toX(anchor.timestamp));
    const band = projection.map(p => `${toX(p.timestamp).toFixed(1)},${toY(p.high).toFixed(1)}`)
      .concat(projection.slice().reverse().map(p => `${toX(p.timestamp).toFixed(1)},${toY(p.low).toFixed(1)}`)).join(' ');
    forecastMarkup = `
      <rect class="market-future" x="${startX.toFixed(1)}" y="${plot.top}" width="${Math.max(0, plotRight - startX).toFixed(1)}" height="${(volumeBottom - plot.top).toFixed(1)}"/>
      <text class="market-future-label" x="${(startX + 8).toFixed(1)}" y="${plot.top + 14}">예측</text>
      <polygon class="market-band" points="${band}" clip-path="url(#${escapeAttribute(ids.svg)}-clip)"/>
      <polyline class="market-forecast" clip-path="url(#${escapeAttribute(ids.svg)}-clip)" points="${projection.map(p => `${toX(p.timestamp).toFixed(1)},${toY(p.value).toFixed(1)}`).join(' ')}"/>`;
  }
  const lastY = toY(last.count);
  const tag = `<line class="market-last-line ${direction}" x1="${plot.left}" x2="${plotRight}" y1="${lastY.toFixed(1)}" y2="${lastY.toFixed(1)}"/>
    <rect class="market-tag ${direction}" x="${plotRight + 2}" y="${(lastY - 10).toFixed(1)}" width="${plot.right - 4}" height="20" rx="4"/>
    <text class="market-tag-text" x="${plotRight + 8}" y="${(lastY + 4).toFixed(1)}">${escapeHtml(formatCompact(last.count))}</text>`;
  const selectionMarkup = options.selectionEnabled === false ? ''
    : selection ? buildSelectionMarkup(selection, toX, axis.endTime, plot, mainBottom - plot.top, ids.selection)
      : `<rect id="${escapeAttribute(ids.selection)}" class="detail-selection hidden"/>`;
  const dayPoints = dailySamples.filter(day => day.dayTimestamp <= axis.endTime && day.dayTimestamp + DAY_MS > axis.startTime)
    .map(day => ({x: Math.min(plotRight, Math.max(plot.left, toX(day.dayTimestamp))), sample: day}));

  return {
    model: {width, height, points, dayPoints, plot, timeAxis: axis, displayMode, unit, forecast,
      anchorX: forecast ? toX(anchor.timestamp) : Infinity, mainBottom, volumeBottom,
      dailyByDay: new Map(dailySamples.map(day => [day.dayTimestamp, day])),
      toTime: x => axis.startTime + (x - plot.left) / plotWidth * (axis.endTime - axis.startTime), toY, low, high},
    svg: `
      <div class="market-readout" id="${escapeAttribute(ids.readout)}" aria-live="off"></div>
      <div class="detail-chart-wrap market-chart-wrap">
        <svg id="${escapeAttribute(ids.svg)}" class="detail-chart market-chart" tabindex="0" aria-keyshortcuts="ArrowLeft ArrowRight Home End"
          viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttribute(options.title || '구독자 수 추이')}">
          <defs>
            <clipPath id="${escapeAttribute(ids.svg)}-clip"><rect x="${plot.left}" y="${plot.top}" width="${plotWidth}" height="${mainBottom - plot.top}"/></clipPath>
            <linearGradient id="${escapeAttribute(ids.svg)}-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" class="market-fill-top ${direction}"/><stop offset="100%" class="market-fill-bottom"/>
            </linearGradient>
          </defs>
          ${timeTicks}
          ${valueTicks}
          <line class="market-divider" x1="${plot.left}" x2="${plotRight}" y1="${mainBottom}" y2="${mainBottom}"/>
          <text class="market-pane-label" x="${plot.left + 4}" y="${volumeTop - 5}">하루 증가 · <tspan class="market-average-key">7일 평균</tspan></text>
          <text class="market-axis" x="${plotRight + 8}" y="${volumeTop + 10}">${escapeHtml(formatCompact(gainHigh))}</text>
          ${bars}${averageLine}
          ${forecastMarkup}
          <g clip-path="url(#${escapeAttribute(ids.svg)}-clip)">
            <polygon fill="url(#${escapeAttribute(ids.svg)}-fill)" points="${area}"/>
            <polyline class="market-line ${direction}" points="${line.join(' ')}"/>
          </g>
          ${tag}
          ${selectionMarkup}
          <line id="${escapeAttribute(ids.crosshair)}" class="detail-crosshair hidden" y1="${plot.top}" y2="${volumeBottom}"/>
          <g id="${escapeAttribute(ids.crosshair)}-h" class="hidden"><line class="market-hline" x1="${plot.left}" x2="${plotRight}"/>
            <rect class="market-hover-tag" x="${plotRight + 2}" width="${plot.right - 4}" height="20" rx="4"/><text class="market-tag-text" x="${plotRight + 8}"></text></g>
          <circle id="${escapeAttribute(ids.dot)}" class="detail-hover-dot hidden" r="5"/>
        </svg>
      </div>`
  };
}

// Shared hover for both analysis charts: actual samples before the anchor, forecast after it.
// Last cursor position over each chart, so a re-render (wheel zoom, background refresh) keeps the
// readout under a cursor that has not moved.
const marketHoverAt = new Map();

function restoreMarketHover(dialog, model, ids) {
  const clientX = marketHoverAt.get(ids.svg);
  if (clientX === undefined) hideMarketHover(dialog, model, ids);
  else moveMarketHover(dialog, model, {clientX}, ids);
}

function moveMarketHover(dialog, model, event, ids) {
  const svg = dialog.querySelector('#' + ids.svg);
  const bounds = svg?.getBoundingClientRect();
  if (!svg || !bounds?.width || !model?.points?.length) return;
  marketHoverAt.set(ids.svg, event.clientX);
  const viewX = (event.clientX - bounds.left) / bounds.width * model.width;
  const crosshair = dialog.querySelector('#' + ids.crosshair), dot = dialog.querySelector('#' + ids.dot);
  const horizontal = dialog.querySelector('#' + ids.crosshair + '-h'), readout = dialog.querySelector('#' + ids.readout);
  let x, y, value, html;
  if (model.forecast && viewX > model.anchorX && viewX <= model.width - model.plot.right) {
    const time = model.toTime(viewX), p = model.forecast.project((time - model.forecast.anchor.timestamp) / DAY_MS);
    x = viewX; y = model.toY(p.value); value = p.value;
    html = `<span class="market-readout-date">${escapeHtml(formatChartDateTime(time))}</span><span class="market-forecast-key">예측</span>
      <strong>약 ${escapeHtml(formatNumber(p.value))}${model.unit}</strong><span>80% 범위 ${escapeHtml(formatApprox(p.low))} ~ ${escapeHtml(formatApprox(p.high))}</span>`;
  } else {
    const point = window.LivePulseChartHover.nearest(model.points, viewX);
    x = point.x; y = point.y; value = point.sample.count;
    const dayStart = new Date(point.sample.timestamp); dayStart.setHours(0, 0, 0, 0);
    const day = model.dailyByDay.get(dayStart.getTime());
    html = `<span class="market-readout-date">${escapeHtml(model.displayMode === 'daily' ? formatSelectionDate(point.sample.timestamp) : formatChartDateTime(point.sample.timestamp))}</span>
      <strong>${escapeHtml(formatNumber(value))}${model.unit}</strong>
      ${day && Number.isFinite(day.dailyChange) ? `<span>그날 하루 <b class="${day.dailyChange > 0 ? 'up' : day.dailyChange < 0 ? 'down' : ''}">${escapeHtml(formatSignedAnalysis(day.dailyChange, model.unit).value)}</b>${day.elapsedDays > 1 ? ` (${day.elapsedDays}일 평균)` : ''}</span>` : '<span>오늘 · 집계 중</span>'}`;
  }
  crosshair.setAttribute('x1', x); crosshair.setAttribute('x2', x); crosshair.classList.remove('hidden');
  dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.classList.remove('hidden');
  horizontal.querySelector('line').setAttribute('y1', y); horizontal.querySelector('line').setAttribute('y2', y);
  horizontal.querySelector('rect').setAttribute('y', y - 10);
  horizontal.querySelector('text').setAttribute('y', y + 4);
  horizontal.querySelector('text').textContent = formatCompact(value);
  horizontal.classList.remove('hidden');
  readout.innerHTML = html;
}

function hideMarketHover(dialog, model, ids) {
  marketHoverAt.delete(ids.svg);
  for (const id of [ids.crosshair, ids.crosshair + '-h', ids.dot]) dialog.querySelector('#' + id)?.classList.add('hidden');
  const readout = dialog.querySelector('#' + ids.readout);
  if (readout && model) readout.innerHTML = model.defaultReadout || '';
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
  if (!svg && marketHoverAt.has(SUBSCRIBER_CHART_IDS.svg)) hideDetailChartTooltip();
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

  moveMarketHover(elements.subscriberDialog, detailChartModel, event, SUBSCRIBER_CHART_IDS);
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
  const svg = event.target.closest?.('#subscriber-detail-svg');
  const model = detailChartModel;
  if (!svg || !model?.points?.length || !model?.fullTimeAxis || !event.deltaY) return;
  const bounds = svg.getBoundingClientRect();
  if (!bounds.width) return;

  event.preventDefault();
  const currentWindow = subscriberChartViewport || model.fullTimeAxis;
  const anchorTime = wheelAnchorTime(event, bounds, model, currentWindow);
  const nextWindow = window.LivePulseChartMath.zoomTimeWindow(
    currentWindow,
    model.fullTimeAxis,
    anchorTime,
    Math.exp(Math.max(-120, Math.min(120, event.deltaY)) * 0.001),
    CHART_MINIMUM_SPAN_MS
  );
  if (!nextWindow || isSameTimeWindow(nextWindow, currentWindow)) return;
  subscriberChartViewport = isSameTimeWindow(nextWindow, model.fullTimeAxis) ? null : nextWindow;
  subscriberChartSelection = null;
  detailChartDrag = null;
  renderSubscriberDetail();
}

function handleVideoViewPointerMove(event) {
  if (!event.target.closest?.('#video-view-detail-svg')) {
    if (marketHoverAt.has(VIDEO_CHART_IDS.svg)) hideVideoViewTooltip();
    return;
  }
  moveMarketHover(elements.videoViewDialog, videoViewChartModel, event, VIDEO_CHART_IDS);
}

function handleVideoViewWheel(event) {
  const svg = event.target.closest?.('#video-view-detail-svg');
  const model = videoViewChartModel;
  if (!svg || !model?.points?.length || !model?.fullTimeAxis || !event.deltaY) return;
  const bounds = svg.getBoundingClientRect();
  if (!bounds.width) return;

  event.preventDefault();
  const currentWindow = videoViewChartViewport || model.fullTimeAxis;
  const anchorTime = wheelAnchorTime(event, bounds, model, currentWindow);
  const nextWindow = window.LivePulseChartMath.zoomTimeWindow(
    currentWindow,
    model.fullTimeAxis,
    anchorTime,
    event.deltaY < 0 ? 0.8 : 1.25,
    CHART_MINIMUM_SPAN_MS
  );
  if (!nextWindow || isSameTimeWindow(nextWindow, currentWindow)) return;
  videoViewChartViewport = isSameTimeWindow(nextWindow, model.fullTimeAxis) ? null : nextWindow;
  renderVideoViewDetail();
}

function hideVideoViewTooltip() {
  hoverFrames.clear('video');
  hideMarketHover(elements.videoViewDialog, videoViewChartModel, VIDEO_CHART_IDS);
}

// The drawn axis may extend into the forecast, so map the cursor through it, then keep it in data.
function wheelAnchorTime(event, bounds, model, currentWindow) {
  const time = model.toTime((event.clientX - bounds.left) / bounds.width * model.width);
  return Math.min(currentWindow.endTime, Math.max(currentWindow.startTime, time));
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
  hideMarketHover(elements.subscriberDialog, detailChartModel, SUBSCRIBER_CHART_IDS);
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
  elements.settingLocalStats.checked = settings.recordLocalStatistics === true;
  elements.localStatsHelp.textContent = localStatisticsHelp(settings);
  elements.settingSubscriberChartMode.value = readChartPreferences().subscriberMode;
  elements.settingInterval.value = settings.pollIntervalSeconds;
  elements.settingApiKey.value = '';
  elements.settingCloudUrl.value = settings.cloudUrl || '';
  elements.settingCloudToken.value = '';
  elements.settingCloudToken.placeholder = settings.hasCloudToken ? '저장된 연결 키 유지' : '새로 연결할 때 입력';
  elements.settingBackupFolder.value = settings.externalBackupFolder || '';
  const backup = appState.app?.externalBackup || {};
  elements.backupFolderStatus.textContent = !settings.externalBackupFolder ? '외부 백업 안 함'
    : backup.error || (backup.running ? '백업하는 중…'
      : backup.lastAt ? `최근 외부 백업: ${new Date(backup.lastAt).toLocaleString('ko-KR')}` : '곧 첫 백업을 만듭니다.');
  elements.cloudSyncStatus.textContent = appState.cloud?.error || (settings.cloudUrl
    ? (appState.cloud?.lastSyncAt ? `최근 동기화: ${new Date(appState.cloud.lastSyncAt).toLocaleString('ko-KR')}` : '연결 후 동기화를 기다립니다.')
    : '클라우드 연결 안 됨');
  elements.settingApiKey.placeholder = settings.hasApiKey
    ? '저장된 키 유지 (변경할 때만 입력)'
    : '입력하지 않아도 작동합니다';
  elements.apiKeyStatus.textContent = settings.hasApiKey
    ? 'API 키 저장됨 · 공식 채널·영상 통계를 사용합니다. 구독자 수는 공개 정책상 반올림됩니다.'
    : 'API 키 없음 · 공개 페이지로 영상 감지와 조회수 수집을 계속합니다.';
  elements.startupHelp.textContent = appState.app?.nativePersonal
    ? (appState.app?.loginSettingApplied
      ? 'Windows 시작 시 개인용 앱을 실행합니다.'
      : '저장하면 Windows 시작 항목을 현재 앱 위치로 맞춥니다.')
    : appState.app?.isPackaged
    ? 'Windows 시작 앱 설정에 반영됩니다.'
    : '개발 실행 중에는 등록하지 않으며, 설치본에서 적용됩니다.';
  elements.settingsDialog.showModal();
}

// Mirrors the host rule: without recent cloud samples the PC records subscriber/view history itself.
function localStatisticsHelp(settings) {
  const base = '끄면 클라우드 기록만 사용하고, 클라우드 수집이 멈추면 자동으로 이 PC에서 기록합니다.';
  if (settings.recordLocalStatistics) return '켜짐 · 클라우드와 별도로 이 PC에서도 구독자·조회수를 기록합니다.';
  if (!settings.cloudUrl) return `${base} 지금은 클라우드가 연결되지 않아 이 PC에서 기록합니다.`;
  const collected = Date.parse(appState.cloud?.lastCollectionAt || '');
  const stale = appState.cloud?.error || !Number.isFinite(collected) || Date.now() - collected > 10 * 60 * 1000;
  return stale ? `${base} 지금은 클라우드 수집이 멈춰 이 PC에서 대신 기록합니다.` : `${base} 지금은 클라우드 기록을 사용합니다.`;
}

async function handleSaveSettings(event) {
  event.preventDefault();
  const update = {
    startAtLogin: elements.settingStartup.checked,
    autoOpenLive: elements.settingLive.checked,
    autoOpenUpcoming: elements.settingUpcoming.checked,
    notifyNewVideos: elements.settingVideos.checked,
    notifyNewPosts: elements.settingPosts.checked,
    recordLocalStatistics: elements.settingLocalStats.checked,
    subscriberChartMode: elements.settingSubscriberChartMode.value,
    pollIntervalSeconds: Number(elements.settingInterval.value),
    cloudUrl: elements.settingCloudUrl.value.trim(),
    externalBackupFolder: elements.settingBackupFolder.value.trim()
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

function formatApprox(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return cachedFormatter('NumberFormat', { notation: 'compact', maximumSignificantDigits: 3 }).format(numeric);
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
