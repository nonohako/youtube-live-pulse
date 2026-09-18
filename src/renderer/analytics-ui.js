'use strict';
let viewsPageActive = false;
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
  document.getElementById('views-count').textContent = `${videos.length}개 영상`;
  const grid = document.getElementById('views-grid');
  const html = videos.map(v => `<article class="view-card">
    <button class="view-card-open" data-video-view-channel="${escapeAttribute(v.channelId)}" data-video-view-chart="${escapeAttribute(v.videoId)}" aria-label="${escapeAttribute(v.title)} 조회수 차트">
      <img src="https://i.ytimg.com/vi/${escapeAttribute(v.videoId)}/mqdefault.jpg" loading="lazy" alt="">
      <span class="view-card-body"><span class="muted">${escapeHtml(v.channelTitle)}</span><strong>${escapeHtml(v.title || v.videoId)}</strong><span class="view-card-count">${formatNumber(v.samples.at(-1).count)}<small> 조회</small></span><span class="muted">마지막 수집 ${escapeHtml(formatChartDateTime(Date.parse(v.samples.at(-1).at)))}</span></span>
    </button>
    <label class="compare-choice"><input type="checkbox" data-compare-video="${escapeAttribute(v.key)}" ${comparisonSelection.has(v.key) ? 'checked' : ''} ${comparisonSelection.size >= 4 && !comparisonSelection.has(v.key) ? 'disabled' : ''}> 비교 선택</label>
  </article>`).join('') || '<div class="detail-chart-empty">표시할 영상 기록이 없습니다.</div>';
  if (grid.innerHTML !== html) grid.innerHTML = html;
  const compare = document.getElementById('views-compare');
  compare.textContent = `선택한 영상 비교 (${comparisonSelection.size}/4)`;
  compare.disabled = comparisonSelection.size < 2;
}

function renderVideoComparison() {
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
  const dates = Array.from({length: model.start === model.end ? 1 : 5}, (_, i) => {
    const time = model.start + span*i/4;
    return `<text x="${x(time)}" y="${height-17}" text-anchor="middle" fill="#9299a8" font-size="11">${escapeHtml(formatChartDate(time))}</text>`;
  }).join('');
  const paths = model.series.map((series, index) => {
    const color = comparisonColors[index];
    const d = series.samples.map((s,i) => `${i ? 'L' : 'M'}${x(s.timestamp).toFixed(2)} ${y(s.value).toFixed(2)}`).join(' ');
    // Only observed samples form the path; never extrapolate before/after them.
    const points = series.samples.filter((_s,i) => i === 0 || i === series.samples.length-1 || i % Math.max(1,Math.ceil(series.samples.length/160)) === 0);
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5"/>` + points.map(s => `<circle cx="${x(s.timestamp)}" cy="${y(s.value)}" r="3" fill="${color}"><title>${escapeHtml(series.title)} · ${escapeHtml(formatChartDateTime(s.timestamp))} · ${formatNumber(s.value)}회</title></circle>`).join('');
  }).join('');
  content.innerHTML = `<svg class="compare-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="선택 영상 조회수 비교 차트"><title>선택 영상 조회수 비교</title>${ticks}${dates}${paths}</svg>
    <div class="comparison-legend">${model.series.map((s,i) => `<div class="comparison-item comparison-color-${i}"><strong>${escapeHtml(s.title)}</strong><span>${escapeHtml(s.channelTitle)}</span><span>최근 ${s.last ? formatNumber(s.last.count) : '기록 없음'} · 기간 증가 ${s.change === null ? '자료 부족' : `${s.change >= 0 ? '+' : ''}${formatNumber(s.change)}`}</span><small>${s.first ? `${escapeHtml(formatChartDateTime(s.first.timestamp))} ~ ${escapeHtml(formatChartDateTime(s.last.timestamp))}` : '선택 기간에 수집 기록이 없습니다.'}</small></div>`).join('')}</div>`;
}

document.addEventListener('DOMContentLoaded', () => {
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
  document.getElementById('views-compare').addEventListener('click', () => {
    if (comparisonSelection.size < 2) return;
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
