'use strict';

let appState = null;
let countdownTimer = null;
let subscriberChartChannelId = null;
let subscriberChartRange = '30d';
let subscriberChartSelection = null;
let detailChartModel = null;
let detailChartDrag = null;

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
    const smokeParams = new URLSearchParams(window.location.search);
    if (smokeParams.has('smokeChart') && appState.channels[0]) {
      openSubscriberChart(
        appState.channels[0].id,
        smokeParams.get('chartRange') || '30d',
        smokeParams.get('chartSelection') === '1'
      );
    }
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
    'startup-help', 'app-version', 'update-button', 'update-status',
    'subscriber-dialog', 'subscriber-close', 'subscriber-dialog-title',
    'subscriber-detail-content'
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
  elements.subscriberDialog.addEventListener('close', () => {
    subscriberChartChannelId = null;
    subscriberChartSelection = null;
    detailChartModel = null;
    detailChartDrag = null;
  });
  elements.subscriberDialog.addEventListener('pointerdown', handleDetailChartPointerDown);
  elements.subscriberDialog.addEventListener('pointermove', handleDetailChartPointerMove);
  elements.subscriberDialog.addEventListener('pointerup', handleDetailChartPointerUp);
  elements.subscriberDialog.addEventListener('pointercancel', handleDetailChartPointerCancel);
  elements.subscriberDialog.addEventListener('pointerleave', hideDetailChartTooltip);
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

    const subscriberButton = event.target.closest('[data-subscriber-chart]');
    if (subscriberButton) {
      openSubscriberChart(subscriberButton.dataset.subscriberChart);
      return;
    }

    const rangeButton = event.target.closest('[data-chart-range]');
    if (rangeButton) {
      subscriberChartRange = rangeButton.dataset.chartRange;
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
  renderChannels();
  renderEvents();
  if (elements.subscriberDialog.open) renderSubscriberDetail();
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

function openSubscriberChart(channelId, initialRange = '30d', selectSmokeRange = false) {
  const channel = appState?.channels.find((item) => item.id === channelId);
  if (!channel) return;
  subscriberChartChannelId = channelId;
  subscriberChartRange = ['7d', '30d', '90d', '1y', 'all'].includes(initialRange)
    ? initialRange
    : '30d';
  subscriberChartSelection = null;
  detailChartDrag = null;
  if (selectSmokeRange) {
    const math = window.LivePulseChartMath;
    const samples = math.filterSamples(channel.subscriberHistory || [], subscriberChartRange);
    const completed = math.analyzeGrowth(samples).daily;
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

function renderSubscriberDetail() {
  const channel = appState?.channels.find((item) => item.id === subscriberChartChannelId);
  if (!channel) {
    elements.subscriberDialog.close();
    return;
  }

  const title = channel.snapshot?.metadata?.title || channel.title || 'YouTube 채널';
  elements.subscriberDialogTitle.textContent = `${title} · 구독자 상세 추이`;
  elements.subscriberDialog.querySelectorAll('[data-chart-range]').forEach((button) => {
    button.classList.toggle('active', button.dataset.chartRange === subscriberChartRange);
  });

  const math = window.LivePulseChartMath;
  const samples = math.filterSamples(channel.subscriberHistory || [], subscriberChartRange);
  const summary = math.summarizeSamples(samples);
  if (!samples.length) {
    detailChartModel = null;
    elements.subscriberDetailContent.innerHTML = `
      <div class="detail-chart-empty">
        <strong>아직 이 기간의 구독자 기록이 없습니다.</strong>
        <span>앱이 채널을 확인하면서 기록을 모으면 여기에 상세 차트가 표시됩니다.</span>
      </div>`;
    return;
  }

  const changeClass = summary.change > 0 ? 'up' : summary.change < 0 ? 'down' : '';
  const changeText = `${summary.change >= 0 ? '+' : ''}${formatNumber(summary.change)}`;
  const slopeText = `${summary.slopePerDay >= 0 ? '+' : ''}${formatTrend(summary.slopePerDay)}/일`;
  const rangeLabel = {
    '7d': '7일',
    '30d': '30일',
    '90d': '90일',
    '1y': '1년',
    all: '전체'
  }[subscriberChartRange] || '선택 기간';

  const growth = math.analyzeGrowth(samples);
  const timeAxis = math.buildTimeAxis(samples, subscriberChartRange);
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
    subscriberChartSelection
  );
  const growthChart = buildGrowthChart(growth.daily, timeAxis);
  detailChartModel = chart.model;
  elements.subscriberDetailContent.innerHTML = `
    <div class="detail-metrics">
      ${renderDetailMetric('현재', formatNumber(summary.current))}
      ${renderDetailMetric(`${rangeLabel} 증감`, changeText, changeClass)}
      ${renderDetailMetric('기간 고점', formatNumber(summary.high))}
      ${renderDetailMetric('기간 저점', formatNumber(summary.low))}
      ${renderDetailMetric('추세', slopeText, summary.slopePerDay > 0 ? 'up' : summary.slopePerDay < 0 ? 'down' : '')}
    </div>
    <div class="detail-chart-legend">
      <span><i class="legend-actual"></i>실제 구독자 수</span>
      <span><i class="legend-trend"></i>선형 추세선</span>
      <span class="detail-selection-hint">날짜 클릭 · 구간 드래그</span>
      <span>${samples.length}개 기록</span>
    </div>
    ${chart.svg}
    ${renderSelectionSummary(selectionSummary)}
    ${renderGrowthAnalysis(growth, growthChart)}`;
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
    '명/일²'
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
    : `이전 3개 평균 ${formatSignedAnalysis(growth.previousMomentum, '명/일').value} → 최근 3개 ${formatSignedAnalysis(growth.recentMomentum, '명/일').value}`;
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
        ${renderGrowthMetric('증가세 둔화', acceleration.value, acceleration.className, '최근 증가량 − 직전 증가량')}
        ${renderGrowthMetric('모멘텀 변화', momentum.value, momentum.className, momentumDetail)}
        ${renderGrowthMetric('기울기 변화', slope.value, slope.className, slopeDetail)}
      </div>
      <div class="growth-chart-legend">
        <strong>일별 증가량 · 성장률 추이</strong>
        <span><i class="legend-growth-bar"></i>증가량</span>
        <span><i class="legend-growth-rate"></i>성장률</span>
      </div>
      ${chart}
      <p class="growth-method">오늘은 집계가 끝나지 않았으므로 모든 성장 분석에서 제외합니다. 완료된 날짜별 마지막 측정값을 마감값으로 사용하고, 측정일 사이가 비면 증가분을 경과 일수로 나눕니다. 둔화는 최근 두 일간 증가량, 모멘텀은 최근 3개와 직전 3개 평균, 기울기는 선택 기간 전반부와 후반부 추세를 비교합니다.</p>
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
    const x = toX(sample.dayTimestamp) - barWidth / 2;
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
      <svg class="growth-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="일별 구독자 증가량과 성장률 추이">
        ${yTicks}
        ${xTicks}
        <line class="growth-zero-line" x1="${plot.left}" y1="${zeroY}" x2="${plot.left + plotWidth}" y2="${zeroY}"/>
        ${bars}
        <polyline class="growth-rate-line" points="${rateLine}"/>
        ${rateDots}
      </svg>
    </div>`;
}

function buildDetailChart(samples, trend, timeAxis, dailySamples = [], selection = null) {
  const width = 840;
  const height = 320;
  const plot = { left: 68, right: 18, top: 18, bottom: 44 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const values = samples.map((sample) => sample.count);
  const trendValues = trend.values || [];
  const combined = [...values, ...trendValues];
  const rawMin = Math.min(...combined);
  const rawMax = Math.max(...combined);
  const rawRange = rawMax - rawMin;
  const padding = Math.max(1, rawRange * 0.12, rawMax * 0.002);
  const minValue = Math.max(0, rawMin - padding);
  const maxValue = rawMax + padding;
  const valueRange = Math.max(1, maxValue - minValue);
  const startTime = timeAxis.startTime;
  const endTime = timeAxis.endTime;
  const timeRange = Math.max(1, endTime - startTime);
  const toX = (timestamp) => plot.left + ((timestamp - startTime) / timeRange) * plotWidth;
  const toY = (value) => plot.top + ((maxValue - value) / valueRange) * plotHeight;
  const points = samples.map((sample) => ({
    x: toX(sample.timestamp),
    y: toY(sample.count),
    sample
  }));
  const dayPoints = dailySamples.map((sample) => ({
    x: toX(sample.dayTimestamp),
    sample
  }));
  const linePoints = points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const areaPoints = `${plot.left},${plot.top + plotHeight} ${linePoints} ${plot.left + plotWidth},${plot.top + plotHeight}`;
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
  const selectionMarkup = selection
    ? buildSelectionMarkup(selection, toX, endTime, plot, plotHeight)
    : '<rect id="detail-selection" class="detail-selection hidden"/>';

  return {
    model: { width, height, points, dayPoints, plot, timeAxis },
    svg: `
      <div class="detail-chart-wrap">
        <svg id="subscriber-detail-svg" class="detail-chart" viewBox="0 0 ${width} ${height}"
          preserveAspectRatio="none" role="img" aria-labelledby="detail-chart-title detail-chart-desc">
          <title id="detail-chart-title">구독자 수 상세 추이</title>
          <desc id="detail-chart-desc">선택한 기간의 실제 구독자 수와 선형 추세선을 나타낸 차트입니다.</desc>
          <defs>
            <linearGradient id="detail-chart-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#38d995" stop-opacity="0.23"/>
              <stop offset="100%" stop-color="#38d995" stop-opacity="0"/>
            </linearGradient>
          </defs>
          ${yTicks}
          ${xTicks}
          <polygon class="detail-chart-area" points="${areaPoints}"/>
          <polyline class="detail-trend-line" points="${trendPoints}"/>
          <polyline class="detail-actual-line" points="${linePoints}"/>
          ${pointDots}
          ${selectionMarkup}
          <line id="detail-crosshair" class="detail-crosshair hidden" y1="${plot.top}" y2="${plot.top + plotHeight}"/>
          <circle id="detail-hover-dot" class="detail-hover-dot hidden" r="5"/>
        </svg>
        <div id="detail-chart-tooltip" class="detail-chart-tooltip hidden"></div>
      </div>`
  };
}

function buildSelectionMarkup(selection, toX, endTime, plot, plotHeight) {
  const startTime = Math.min(selection.startTime, selection.endTime);
  const selectedEnd = Math.max(selection.startTime, selection.endTime);
  const nextDay = new Date(selectedEnd);
  nextDay.setDate(nextDay.getDate() + 1);
  const x = toX(startTime);
  const endX = toX(Math.min(endTime, nextDay.getTime()));
  return `<rect id="detail-selection" class="detail-selection" x="${x.toFixed(2)}" y="${plot.top}" width="${Math.max(2, endX - x).toFixed(2)}" height="${plotHeight}" rx="4"/>`;
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
  const point = detailChartModel.points.reduce((nearest, candidate) => (
    Math.abs(candidate.x - viewX) < Math.abs(nearest.x - viewX) ? candidate : nearest
  ));
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
    <strong>${escapeHtml(formatNumber(point.sample.count))}명</strong>
    <span>${escapeHtml(formatChartDateTime(point.sample.timestamp))}</span>`;
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

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(Math.round(numeric));
}

function formatTrend(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  const absolute = Math.abs(numeric);
  const maximumFractionDigits = absolute < 1 ? 2 : absolute < 10 ? 1 : 0;
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits }).format(numeric);
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  const absolute = Math.abs(numeric);
  const maximumFractionDigits = absolute < 0.01 ? 3 : absolute < 1 ? 2 : 1;
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits }).format(numeric);
}

function formatChartDate(value) {
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric'
  }).format(value);
}

function formatSelectionDate(value) {
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(value);
}

function formatChartDateTime(value) {
  return new Intl.DateTimeFormat('ko-KR', {
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
