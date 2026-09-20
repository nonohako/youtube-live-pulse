'use strict';
let viewsPageActive = false;
const viewSummaryCache = new WeakMap();
function viewIntervalSummary(samples) {
  if (!viewSummaryCache.has(samples)) viewSummaryCache.set(samples, window.LivePulseAnalytics.intervalSummary(samples));
  return viewSummaryCache.get(samples);
}
let comparisonModel = null;
let comparisonRenderKey = '';
function comparisonDataKey() {
  return allViewVideos().filter(v => comparisonSelection.has(v.key)).map(v => v.key + historyRenderKey(v.samples)).join('|');
}
function refreshComparisonIfChanged() {
  if (comparisonRenderKey !== comparisonDataKey()) renderVideoComparison();
}
function hideComparisonHover() {
  hoverFrames.clear('comparison');
  document.getElementById('compare-hover-line')?.classList.add('hidden');
  document.getElementById('compare-hover-tip')?.classList.add('hidden');
  document.querySelectorAll('.compare-hover-dot').forEach(dot => dot.classList.add('hidden'));
}
function moveComparisonHover(event) {
  const svg = event.target.closest?.('.compare-svg');
  const model = comparisonModel;
  if (!svg || !model) return;
  const bounds = svg.getBoundingClientRect();
  if (!bounds.width) return;
  const px = Math.max(model.left, Math.min(model.width - model.right, (event.clientX - bounds.left) / bounds.width * model.width));
  const time = model.start + (px - model.left) / (model.width - model.left - model.right) * model.span;
  const line = document.getElementById('compare-hover-line');
  const tip = document.getElementById('compare-hover-tip');
  if (!line || !tip) return;
  line.setAttribute('x1', px); line.setAttribute('x2', px); line.classList.remove('hidden');
  tip.innerHTML = model.series.map((series, i) => {
    const sample = window.LivePulseChartHover.nearest(series.samples, time, 'timestamp');
    const dot = document.getElementById('compare-hover-dot-' + i);
    if (!sample || time < series.samples[0].timestamp || time > series.samples.at(-1).timestamp) {
      dot?.classList.add('hidden');
      return `<span>${escapeHtml(series.title)} · 이 시각 기록 없음</span>`;
    }
    dot.setAttribute('cx', model.x(sample.timestamp)); dot.setAttribute('cy', model.y(sample.value)); dot.classList.remove('hidden');
    return `<span>${escapeHtml(series.title)}</span><strong>${formatNumber(sample.value)}회</strong><span>${escapeHtml(formatChartDateTime(sample.timestamp))} 관측</span>`;
  }).join('');
  tip.classList.remove('hidden');
  tip.style.left = Math.max(150, Math.min(bounds.width - 150, px / model.width * bounds.width)) + 'px';
  tip.style.top = '12px';
}

const comparisonSelection = new Set();
const comparisonColors = ['#6fa8ff', '#ff784d', '#38d995', '#c698ff'];

function allViewVideos() {
  return (appState?.channels || []).flatMap(channel => (channel.videoViewHistories || [])
    .filter(video => video.samples?.length).map(video => ({...video, channelId: channel.id,
      channelTitle: channel.title || channel.id, key: `${channel.id}:${video.videoId}`})));
}

function showViewsPage(active) {
  viewsPageActive = active;
  document.getElementById('views-page').hidden = !active;
  for (const id of ['dashboard', 'channels-section', 'activity']) document.getElementById(id).hidden = active;
  document.querySelector('.topbar h1').textContent = active ? '영상 조회수' : '채널 현황';
  if (active) {
    document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.id === 'views-nav'));
    renderViewsPanel();
    window.scrollTo({top: 0, behavior: 'instant'});
  }
}

function renderViewsPanel() {
  if (!viewsPageActive || !appState) return;
  const select = document.getElementById('views-channel');
  const selected = select.value;
  const channelOptions = '<option value="">전체 채널</option>' + appState.channels.map(c => `<option value="${escapeAttribute(c.id)}">${escapeHtml(c.title || c.id)}</option>`).join('');
  if (select.innerHTML !== channelOptions) { select.innerHTML = channelOptions; select.value = selected; }
  const all = allViewVideos();
  for (const key of comparisonSelection) if (!all.some(v => v.key === key)) comparisonSelection.delete(key);
  const query = document.getElementById('views-search').value.trim().toLocaleLowerCase();
  const videos = all.filter(v => (!select.value || v.channelId === select.value) && (!query || v.title.toLocaleLowerCase().includes(query)));
  const sort = document.getElementById('views-sort').value;
  videos.sort((a,b) => sort === 'views' ? b.samples.at(-1).count - a.samples.at(-1).count : sort === 'growth' ? (viewIntervalSummary(b.samples).perDay ?? -Infinity) - (viewIntervalSummary(a.samples).perDay ?? -Infinity) : Date.parse(b.samples.at(-1).at) - Date.parse(a.samples.at(-1).at));
  document.getElementById('views-count').textContent = `${videos.length}개 영상`;
  const grid = document.getElementById('views-grid');
  const html = videos.map(v => `<article class="view-card">
    <button class="view-card-open" data-video-view-channel="${escapeAttribute(v.channelId)}" data-video-view-chart="${escapeAttribute(v.videoId)}" aria-label="${escapeAttribute(v.title)} 조회수 차트">
      <img src="https://i.ytimg.com/vi/${escapeAttribute(v.videoId)}/mqdefault.jpg" loading="lazy" alt="">
      <span class="view-card-body"><span class="muted">${escapeHtml(v.channelTitle)}</span><strong>${escapeHtml(v.title || v.videoId)}</strong><span class="view-card-count">${formatNumber(v.samples.at(-1).count)}<small> 조회</small></span><span class="view-card-velocity">${analysisNumber(viewIntervalSummary(v.samples).perDay, '회/일')} <small>기록 기간 평균</small></span><span class="muted">마지막 수집 ${escapeHtml(formatChartDateTime(Date.parse(v.samples.at(-1).at)))}</span></span>
    </button>
    <label class="compare-choice"><input type="checkbox" data-compare-video="${escapeAttribute(v.key)}" ${comparisonSelection.has(v.key) ? 'checked' : ''} ${comparisonSelection.size >= 4 && !comparisonSelection.has(v.key) ? 'disabled' : ''}> 비교 선택</label>
  </article>`).join('') || '<div class="detail-chart-empty">표시할 영상 기록이 없습니다.</div>';
  if (grid.innerHTML !== html) grid.innerHTML = html;
  const compare = document.getElementById('views-compare');
  compare.textContent = `선택한 영상 비교 (${comparisonSelection.size}/4)`;
  compare.disabled = comparisonSelection.size < 2;
}

function renderVideoComparison() {
  comparisonRenderKey = comparisonDataKey();
  comparisonModel = null;
  hoverFrames.clear('comparison');
  const prefs = readChartPreferences();
  document.getElementById('compare-mode').value = prefs.compareMode;
  document.getElementById('compare-metric').value = prefs.compareMetric;
  document.getElementById('compare-ranges').innerHTML = [['7d','7일'],['30d','30일'],['90d','90일'],['1y','1년'],['all','전체']].map(([value,label]) => `<button type="button" data-compare-range="${value}" class="${value === prefs.compareRange ? 'active' : ''}">${label}</button>`).join('');
  const items = allViewVideos().filter(v => comparisonSelection.has(v.key));
  const model = window.LivePulseAnalytics.comparison(items, prefs.compareRange, prefs.compareMode, prefs.compareMetric);
  const content = document.getElementById('compare-content');
  if (!model.series.some(s => s.samples.length)) { content.innerHTML = '<div class="detail-chart-empty">선택 기간에 기록이 없습니다. 더 긴 기간을 선택하세요.</div>'; return; }
  const width = 840, height = 340, left = 74, right = 22, top = 24, bottom = 48;
  const span = Math.max(1, model.end - model.start), spread = Math.max(1, model.high - model.low);
  const x = t => left + (t - model.start) / span * (width-left-right);
  const y = v => height-bottom-(v-model.low)/spread*(height-top-bottom);
  const ticks = Array.from({length: 5}, (_, i) => {
    const value = model.low + spread*i/4;
    return `<line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}" stroke="#292e39"/><text x="${left-10}" y="${y(value)+4}" text-anchor="end" fill="#9299a8" font-size="11">${formatNumber(Math.round(value))}</text>`;
  }).join('');
  const dateAxis = window.LivePulseChartMath.buildTimeWindowAxis(model.start, model.end);
  const dates = window.LivePulseChartMath.detailTicks(dateAxis, prefs.compareMode, width-left-right).map(tick => {
    const px = x(tick.time), base = height-bottom;
    const anchor = px < left+32 ? 'start' : px > width-right-32 ? 'end' : 'middle';
    return `<line class="detail-tick ${tick.major ? 'detail-day-boundary' : 'detail-hour-tick'}" x1="${px}" x2="${px}" y1="${tick.major ? top : base}" y2="${base + (tick.major ? 13 : 6)}"/>
    ${tick.major || tick.label ? `<text class="detail-axis-label detail-time-label ${tick.major ? 'detail-day-label' : ''}" x="${px}" y="${base + (tick.major ? 34 : 19)}" text-anchor="${anchor}">${tick.major ? escapeHtml(formatChartDate(tick.time)) : new Date(tick.time).getHours() + '시'}</text>` : ''}`;
  }).join('');
  const paths = model.series.map((series, index) => {
    const color = comparisonColors[index];
    const d = series.samples.map((s,i) => `${i ? 'L' : 'M'}${x(s.timestamp).toFixed(2)} ${y(s.value).toFixed(2)}`).join(' ');
    // Only observed samples form the path; never extrapolate before/after them.
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5"/>${series.samples.length === 1 ? `<circle cx="${x(series.samples[0].timestamp)}" cy="${y(series.samples[0].value)}" r="4" fill="${color}"/>` : ''}`;

  }).join('');
  comparisonModel = {...model, width, height, left, right, top, bottom, span, x, y};
  content.innerHTML = `<div class="compare-hover-wrap"><svg class="compare-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="선택 영상 조회수 비교 차트"><title>선택 영상 조회수 비교</title>${ticks}${dates}${paths}<line id="compare-hover-line" class="compare-hover-line hidden" y1="${top}" y2="${height-bottom}"/>${model.series.map((s,i) => `<circle id="compare-hover-dot-${i}" class="compare-hover-dot hidden" r="4" fill="${comparisonColors[i]}"/>`).join('')}</svg><div id="compare-hover-tip" class="detail-chart-tooltip compare-hover-tip hidden"></div></div>
    <div class="comparison-legend">${model.series.map((s,i) => `<div class="comparison-item comparison-color-${i}"><strong>${escapeHtml(s.title)}</strong><span>${escapeHtml(s.channelTitle)}</span><span>일평균 ${analysisNumber(viewIntervalSummary(s.samples).perDay, '회/일')}</span><span>최근 ${s.last ? formatNumber(s.last.count) : '기록 없음'} · 기간 증가 ${s.change === null ? '자료 부족' : `${s.change >= 0 ? '+' : ''}${formatNumber(s.change)}`}</span><small>${s.first ? `${escapeHtml(formatChartDateTime(s.first.timestamp))} ~ ${escapeHtml(formatChartDateTime(s.last.timestamp))}` : '선택 기간에 수집 기록이 없습니다.'}</small></div>`).join('')}</div>`;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('compare-dialog').addEventListener('pointermove', event => queueHover('comparison', event, moveComparisonHover));
  document.getElementById('compare-dialog').addEventListener('pointerleave', hideComparisonHover);
  document.getElementById('compare-dialog').addEventListener('close', () => { hideComparisonHover(); requestAnimationFrame(render); void releaseAnalytics(); });
  document.getElementById('views-nav').addEventListener('click', () => showViewsPage(true));
  document.getElementById('views-search').addEventListener('input', renderViewsPanel);
  document.getElementById('views-channel').addEventListener('change', renderViewsPanel);
  document.getElementById('views-grid').addEventListener('change', e => {
    const key = e.target.dataset.compareVideo;
    if (!key) return;
    if (e.target.checked && comparisonSelection.size < 4) comparisonSelection.add(key);
    else comparisonSelection.delete(key);
    renderViewsPanel();
  });
  document.getElementById('views-clear').addEventListener('click', () => { comparisonSelection.clear(); renderViewsPanel(); });
  document.getElementById('views-compare').addEventListener('click', async () => {
    if (comparisonSelection.size < 2) return;
    if (appState?.analyticsLazy && !await requestAnalytics({subscriberId: null, videos: [...comparisonSelection].map(key => { const [channelId, videoId] = key.split(':'); return {channelId, videoId}; })})) return;
    renderVideoComparison(); document.getElementById('compare-dialog').showModal();
  });
  document.getElementById('compare-close').addEventListener('click', () => document.getElementById('compare-dialog').close());
  document.getElementById('compare-ranges').addEventListener('click', e => {
    const range = e.target.closest('[data-compare-range]')?.dataset.compareRange;
    if (range) { saveChartPreference('compareRange', range); renderVideoComparison(); }
  });
  for (const [id, key] of [['compare-mode','compareMode'],['compare-metric','compareMetric']]) {
    document.getElementById(id).addEventListener('change', e => { saveChartPreference(key,e.target.value); renderVideoComparison(); });
  }
  document.getElementById('subscriber-chart-mode').addEventListener('change', e => {
    saveChartPreference('subscriberMode',e.target.value); subscriberChartViewport = null; subscriberChartSelection = null; renderSubscriberDetail();
  });
  document.getElementById('video-chart-mode').addEventListener('change', e => {
    saveChartPreference('videoMode',e.target.value); videoViewChartViewport = null; renderVideoViewDetail();
  });
});
