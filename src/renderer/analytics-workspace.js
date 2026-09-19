'use strict';

function analysisNumber(value, unit = '') {
  return value === null || !Number.isFinite(value) ? '자료 부족' : `${value > 0 ? '+' : ''}${formatTrend(value)}${unit}`;
}

function analysisOverview(samples, unit, completed = null) {
  const stats = window.LivePulseAnalytics.intervalSummary(samples);
  if (!stats.last) return '<p class="analysis-chart-help">이 구간에 실제 관측 기록이 없습니다.</p>';
  const growth = completed ? window.LivePulseChartMath.summarizeDailyRange(completed, -Infinity, Infinity) : null;
  const change = completed ? growth?.totalChange ?? null : stats.change;
  const speed = completed ? growth?.averageDailyChange ?? null : stats.perDay;
  const percent = completed ? growth?.periodGrowthRate ?? null : stats.percent;
  return `<div class="analysis-kpis">
    ${analysisKpi('마지막 관측값', `${formatNumber(stats.last.count)}<small>${unit}</small>`, formatChartDateTime(stats.last.timestamp))}
    ${analysisKpi('기간 증감', analysisNumber(change, unit), completed ? '완료된 날짜 · 직전 마감값 대비' : '선택 구간 첫 기록 대비', change)}
    ${analysisKpi('일평균 증가 속도', analysisNumber(speed, `${unit}/일`), completed ? '완료 구간 평균 · 빈 날짜 경과 반영' : '실제 관측 간격 기준 · 하루 환산', speed)}
    ${analysisKpi('기간 증가율', percent === null ? '자료 부족' : `${percent > 0 ? '+' : ''}${formatPercent(percent)}%`, completed ? '오늘 제외 · 직전 마감값 대비' : '선택 구간 첫 기록 대비', percent)}
  </div>`;
}

function analysisKpi(label, value, note, change = null) {
  return `<section class="analysis-kpi"><span>${escapeHtml(label)}</span><strong class="${change > 0 ? 'up' : change < 0 ? 'down' : ''}">${value}</strong><small>${escapeHtml(note)}</small></section>`;
}

function analysisCaption(samples, metric, unit, mode) {
  const first = samples[0], last = samples.at(-1);
  const date = mode === 'daily' ? formatSelectionDate : formatChartDateTime;
  return `<div class="analysis-chart-heading"><div><h3>${metric === 'change' ? '기간 내 증감' : unit === '명' ? '구독자 추이' : '누적 조회수'}</h3><span>${escapeHtml(date(first.timestamp))} — ${escapeHtml(date(last.timestamp))}</span></div><span class="analysis-records">${formatNumber(samples.length)}${mode === 'daily' ? '개 날짜' : '개 관측'}</span></div>
    <p class="analysis-chart-help">${metric === 'change' ? (unit === '회' ? '기간 첫 실제 관측값 대비 증감입니다. ' : '첫 표시 기록 대비 증감입니다. ') : ''}마우스를 움직여 수치 확인 · 휠로 확대${unit === '명' ? ' · 날짜를 드래그해 구간 분석' : ''}</p>`;
}

function analysisDailyTable(daily, unit) {
  const rows = daily.slice(-10).reverse();
  return `<section class="analysis-record-panel"><div class="analysis-chart-heading"><h3>일별 변화</h3><span>최근 완료일 최대 10개 · 오늘 제외</span></div>${rows.length ? `<table class="analysis-table"><thead><tr><th>날짜</th><th>마지막 값</th><th>직전 기록 대비</th><th>일평균 증가</th></tr></thead><tbody>${rows.map(d => `<tr><td>${escapeHtml(formatSelectionDate(d.dayTimestamp))}${d.elapsedDays > 1 ? `<small>${d.elapsedDays}일 간격</small>` : ''}</td><td>${formatNumber(d.count)}${unit}</td><td class="${d.rawChange > 0 ? 'up' : d.rawChange < 0 ? 'down' : ''}">${analysisNumber(d.rawChange, unit)}</td><td>${analysisNumber(d.dailyChange, `${unit}/일`)}</td></tr>`).join('')}</tbody></table>` : '<p class="analysis-chart-help">완료된 날짜의 기록이 쌓이면 일별 변화를 표시합니다.</p>'}</section>`;
}

document.addEventListener('DOMContentLoaded', () => {
  for (const [kind, dialogId, renderChart] of [['subscriber', 'subscriber-dialog', renderSubscriberDetail], ['video', 'video-view-dialog', renderVideoViewDetail]]) {
    const dialog = document.getElementById(dialogId);
    dialog.classList.add('analytics-workspace');
    const header = dialog.querySelector('.dialog-header');
    header.querySelector('.eyebrow').textContent = kind === 'subscriber' ? '구독자 분석' : '영상 분석';
    if (kind === 'video') {
      const image = document.createElement('img'); image.id = 'analysis-video-thumbnail'; image.alt = ''; image.className = 'analysis-video-thumbnail'; header.prepend(image); 
      const picker = document.createElement('details'); picker.className = 'analysis-video-picker';
      picker.innerHTML = '<summary>다른 영상 선택</summary>';
      const label = dialog.querySelector('.video-view-select-label'); label.before(picker); picker.append(label);
    }
    const toolbar = dialog.querySelector('.chart-toolbar');
    const controls = document.createElement('div');
    controls.className = 'analysis-controls';
    toolbar.before(controls);
    controls.append(toolbar, dialog.querySelector('.chart-mode'));
    const metric = document.createElement('div');
    metric.className = 'analysis-metric-switch';
    metric.setAttribute('aria-label', '차트에 표시할 값');
    metric.innerHTML = `<button type="button" data-analysis-metric="total">${kind === 'subscriber' ? '구독자 수' : '누적 조회수'}</button><button type="button" data-analysis-metric="change">기간 증감</button>`;
    controls.append(metric);
    metric.addEventListener('click', e => {
      const value = e.target.closest('[data-analysis-metric]')?.dataset.analysisMetric;
      if (!value) return;
      saveChartPreference(kind + 'Metric', value);
      renderChart();
    });
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
