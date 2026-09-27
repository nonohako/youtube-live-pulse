'use strict';

function analysisNumber(value, unit = '') {
  return value === null || !Number.isFinite(value) ? '자료 부족' : `${value > 0 ? '+' : ''}${formatTrend(value)}${unit}`;
}

// Stock-style headline: the latest value and its change since the previous completed day's close.
function analysisTicker(history, unit, now = Date.now()) {
  const samples = window.LivePulseChartMath.normalizeSamples(history).filter(s => s.timestamp <= now);
  const last = samples.at(-1);
  if (!last) return '';
  const day = new Date(last.timestamp); day.setHours(0, 0, 0, 0);
  const close = samples.filter(s => s.timestamp < day.getTime()).at(-1);
  const change = close ? last.count - close.count : null;
  const percent = close?.count > 0 ? change / close.count * 100 : null;
  const tone = change > 0 ? 'up' : change < 0 ? 'down' : '';
  const chip = change === null ? '<span class="ticker-chip">전날 기록 없음</span>'
    : change === 0 ? '<span class="ticker-chip">변동 없음</span>'
    : `<span class="ticker-chip ${tone}">${change > 0 ? '▲' : change < 0 ? '▼' : '−'} ${formatNumber(Math.abs(change))}${percent === null ? '' : ` (${change >= 0 ? '+' : '−'}${formatPercent(Math.abs(percent))}%)`}</span>`;
  return `<strong>${formatNumber(last.count)}<small>${unit}</small></strong>${chip}
    <span class="ticker-note">${close ? `${escapeHtml(formatChartDate(close.timestamp))} 마감 대비 · ` : ''}${escapeHtml(formatChartDateTime(last.timestamp))} 기준</span>`;
}

function marketDefaultReadout(last, unit, mode, selectable) {
  return `<span class="market-readout-date">${escapeHtml(mode === 'daily' ? formatSelectionDate(last.timestamp) : formatChartDateTime(last.timestamp))}</span>
    <strong>${formatNumber(last.count)}${unit}</strong>
    <span class="market-hint">마우스로 값 확인 · 휠로 확대${selectable ? ' · 날짜 드래그로 구간 분석' : ''} · 오른쪽 음영은 예측</span>`;
}

function analysisOutlook(forecast, unit) {
  const video = forecast.kind === 'video';
  const compact = value => `${formatApprox(value)}${unit}`;
  const range = p => `${formatApprox(p.low)} ~ ${formatApprox(p.high)}`;
  const pace = forecast.momentum === null ? '' : Math.abs(forecast.momentum) < 0.1 ? '이전 7일과 비슷한 속도'
    : `이전 7일보다 ${formatPercent(Math.abs(forecast.momentum) * 100)}% ${forecast.momentum > 0 ? '빨라짐' : '느려짐'}`;
  const rows = [];
  if (forecast.recent !== null) rows.push(['최근 7일 하루 평균', `${analysisNumber(forecast.recent, unit)}`, pace,
    forecast.momentum > 0.1 ? 'up' : forecast.momentum < -0.1 ? 'down' : '']);
  if (!forecast.ready) {
    return `<aside class="market-outlook"><h3>전망 <small>참고용 추정</small></h3>
      <dl class="outlook-list">${rows.map(outlookRow).join('')}</dl>
      <p class="outlook-empty">${escapeHtml(forecast.reason)}</p></aside>`;
  }
  const week = forecast.project(7), month = forecast.project(30), milestone = forecast.milestone;
  if (video) rows.push(['증가 속도 변화', forecast.halfLifeDays === null ? '줄지 않음'
    : `약 ${formatTrend(forecast.halfLifeDays)}일마다 절반`, `지금 하루 약 ${compact(forecast.rate)}`, '']);
  rows.push(['7일 뒤', `약 ${compact(week.value)}`, `80% 범위 ${range(week)}`, '']);
  rows.push(['30일 뒤', `약 ${compact(month.value)}`, `80% 범위 ${range(month)}`, '']);
  rows.push([`${compact(milestone.target)} 도달`, milestone.days === null ? '지금 추세로는 어려움'
    : milestone.days < 1 ? '하루 안에' : `${formatChartDate(milestone.timestamp)} 전후`,
    milestone.days === null ? '1년 이상 걸리거나 증가가 멈춤' : `약 ${formatTrend(Math.max(1, milestone.days))}일 뒤`, '']);
  const summary = video
    ? `지금 하루 약 ${compact(forecast.rate)}씩 늘고 있고, ${forecast.halfLifeDays === null ? '증가 속도가 줄지 않고 있어요' : `증가 속도는 약 ${formatTrend(forecast.halfLifeDays)}일마다 절반으로 줄고 있어요`}. 7일 뒤 약 ${compact(week.value)}로 예상돼요.`
    : `${forecast.recent === null ? '' : `최근 7일 하루 평균 ${analysisNumber(forecast.recent, unit)}씩 늘었어요${pace ? ` (${pace})` : ''}. `}이 추세라면 30일 뒤 약 ${compact(month.value)}으로 예상돼요.`;
  return `<aside class="market-outlook"><h3>전망 <small>참고용 추정</small></h3>
    <p class="outlook-summary">${escapeHtml(summary)}</p>
    <dl class="outlook-list">${rows.map(outlookRow).join('')}</dl>
    <p class="outlook-method">최근 ${forecast.windowDays}일의 완료된 날짜 기록으로 계산했습니다. 오늘은 집계 중이라 제외하며, 예측은 저장하지 않습니다.</p></aside>`;
}

function outlookRow([label, value, note, tone]) {
  return `<div><dt>${escapeHtml(label)}</dt><dd><strong>${escapeHtml(value)}</strong>${note ? `<small class="${tone}">${escapeHtml(note)}</small>` : ''}</dd></div>`;
}

const analysisRecordPages = new Map();
function analysisDailyTable(daily, unit, context, requestedPage) {
  const previous = analysisRecordPages.get(unit);
  const key = JSON.stringify(context);
  const pages = Math.max(1, Math.ceil(daily.length / 10));
  const page = Math.max(0, Math.min(pages - 1, requestedPage ?? (previous?.key === key ? previous.page : 0)));
  analysisRecordPages.set(unit, {daily, unit, context, key, page});
  const rows = daily.slice().reverse().slice(page * 10, (page + 1) * 10);
  return `<section class="analysis-record-panel" data-record-unit="${unit}"><div class="analysis-chart-heading"><h3>일별 변화</h3><span>완료일 ${daily.length}개 · 오늘 제외</span></div>${rows.length ? `<nav class="record-pagination" aria-label="일별 기록 페이지"><button type="button" data-record-step="-1" ${page === 0 ? 'disabled' : ''}>최근 기록</button><span aria-live="polite">${page + 1} / ${pages} 페이지</span><button type="button" data-record-step="1" ${page === pages - 1 ? 'disabled' : ''}>이전 기록</button></nav><table class="analysis-table"><thead><tr><th>날짜</th><th>마지막 값</th><th>직전 기록 대비</th><th>일평균 증가</th></tr></thead><tbody>${rows.map(d => `<tr><td>${escapeHtml(formatSelectionDate(d.dayTimestamp))}${d.elapsedDays > 1 ? `<small>${d.elapsedDays}일 간격</small>` : ''}</td><td>${formatNumber(d.count)}${unit}</td><td class="${d.rawChange > 0 ? 'up' : d.rawChange < 0 ? 'down' : ''}">${analysisNumber(d.rawChange, unit)}</td><td>${analysisNumber(d.dailyChange, `${unit}/일`)}</td></tr>`).join('')}</tbody></table>` : '<p class="analysis-chart-help">완료된 날짜의 기록이 쌓이면 일별 변화를 표시합니다.</p>'}</section>`;
}

document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-record-step]');
    if (!button) return;
    const panel = button.closest('[data-record-unit]');
    const state = analysisRecordPages.get(panel.dataset.recordUnit);
    const parent = panel.parentElement;
    const step = button.dataset.recordStep;
    panel.outerHTML = analysisDailyTable(state.daily, state.unit, state.context, state.page + Number(step));
    const next = parent.querySelector(`[data-record-step="${step}"]:not(:disabled)`) || parent.querySelector('[data-record-step]:not(:disabled)');
    next?.focus({preventScroll: true});
  });
  for (const [kind, dialogId] of [['subscriber', 'subscriber-dialog'], ['video', 'video-view-dialog']]) {
    const dialog = document.getElementById(dialogId);
    dialog.addEventListener('close', () => analysisRecordPages.delete(kind === 'subscriber' ? '명' : '회'));
    dialog.classList.add('analytics-workspace');
    const header = dialog.querySelector('.dialog-header');
    header.querySelector('.eyebrow').textContent = kind === 'subscriber' ? '구독자 분석' : '영상 분석';
    if (kind === 'video') {
      const image = document.createElement('img'); image.id = 'analysis-video-thumbnail'; image.alt = ''; image.className = 'analysis-video-thumbnail'; header.prepend(image); 
      const picker = document.createElement('details'); picker.className = 'analysis-video-picker';
      picker.innerHTML = '<summary>다른 영상 선택</summary>';
      const label = dialog.querySelector('.video-view-select-label'); label.before(picker); picker.append(label);
    }
    const tabs = document.createElement('div');
    tabs.className = 'analysis-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '분석 화면');
    const sections = [['overview','차트'],['records','일별 기록']];
    tabs.innerHTML = sections.map(([value,label], i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-analysis-tab="${value}">${label}</button>`).join('');
    header.after(tabs); dialog.dataset.analysisTab = 'overview';
    tabs.addEventListener('click', e => {
      const button = e.target.closest('[data-analysis-tab]'); if (!button) return;
      dialog.dataset.analysisTab = button.dataset.analysisTab;
      tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', b === button));
      dialog.firstElementChild.scrollTop = 0;
    });
    tabs.addEventListener('keydown', e => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
      e.preventDefault(); const buttons = [...tabs.querySelectorAll('button')];
      const at = buttons.indexOf(document.activeElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus(); buttons[next].click();
    });
    dialog.addEventListener('keydown', e => {
      const svg = e.target.closest('.detail-chart');
      if (!svg || !['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
      e.preventDefault();
      const model = kind === 'subscriber' ? detailChartModel : videoViewChartModel;
      if (!model?.points.length) return;
      let at = Number(svg.dataset.keyboardIndex || 0);
      at = e.key === 'Home' ? 0 : e.key === 'End' ? model.points.length - 1 : Math.max(0, Math.min(model.points.length - 1, at + (e.key === 'ArrowRight' ? 1 : -1)));
      svg.dataset.keyboardIndex = at;
      const rect = svg.getBoundingClientRect(), point = model.points[at];
      const event = {target: svg, pointerId: -1, clientX: rect.left + point.x / model.width * rect.width};
      (kind === 'subscriber' ? handleDetailChartPointerMove : handleVideoViewPointerMove)(event);
    });
    const toolbar = dialog.querySelector('.chart-toolbar');
    const controls = document.createElement('div');
    controls.className = 'analysis-controls';
    toolbar.before(controls);
    controls.append(document.getElementById(kind + '-ticker'), toolbar, dialog.querySelector('.chart-mode'));
    const disclaimer = dialog.querySelector('.chart-disclaimer');
    const help = document.createElement('details');
    help.className = 'analysis-help';
    help.innerHTML = '<summary>수집 방식과 통계 해석</summary>';
    disclaimer.before(help); help.append(disclaimer);
  }
  const compare = document.getElementById('compare-dialog');
  compare.classList.add('analytics-workspace');
  document.getElementById('views-sort').addEventListener('change', renderViewsPanel);
});
