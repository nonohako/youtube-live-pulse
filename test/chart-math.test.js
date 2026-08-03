'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeGrowth,
  analyzeGrowthForRange,
  analyzeGrowthForTimeWindow,
  buildCompletedDayAxis,
  buildDailySeries,
  buildTimeAxis,
  buildTimeWindowAxis,
  collapseSamplesByLocalDate,
  filterSamples,
  filterSamplesInTimeWindow,
  filterSamplesWithBaselineInTimeWindow,
  linearRegression,
  normalizeSamples,
  summarizeDailyRange,
  summarizeSamples,
  zoomTimeWindow
} = require('../src/renderer/chart-math');

const DAY_MS = 24 * 60 * 60 * 1000;

test('구독자 기록을 시간순으로 정리하고 잘못된 값을 제외한다', () => {
  const samples = normalizeSamples([
    { at: '2026-07-03T00:00:00.000Z', count: 130 },
    { at: 'invalid', count: 999 },
    { at: '2026-07-01T00:00:00.000Z', count: 100 },
    { at: '2026-07-02T00:00:00.000Z', count: '115' }
  ]);

  assert.deepEqual(samples.map((sample) => sample.count), [100, 115, 130]);
});

test('선택한 날짜 구간에 포함되는 기록만 반환한다', () => {
  const now = new Date('2026-07-31T00:00:00.000Z').getTime();
  const history = [
    { at: '2026-06-01T00:00:00.000Z', count: 100 },
    { at: '2026-07-05T00:00:00.000Z', count: 120 },
    { at: '2026-07-29T00:00:00.000Z', count: 140 }
  ];

  assert.deepEqual(filterSamples(history, '7d', now).map((sample) => sample.count), [140]);
  assert.deepEqual(filterSamples(history, '30d', now).map((sample) => sample.count), [120, 140]);
  assert.equal(filterSamples(history, 'all', now).length, 3);
});

test('7일 범위는 오늘을 포함한 로컬 달력 7일로 계산한다', () => {
  const now = new Date(2026, 7, 1, 15, 0).getTime();
  const history = [
    { at: new Date(2026, 6, 25, 23, 59).toISOString(), count: 100 },
    { at: new Date(2026, 6, 26, 0, 0).toISOString(), count: 110 },
    { at: new Date(2026, 7, 1, 14, 0).toISOString(), count: 120 }
  ];

  assert.deepEqual(filterSamples(history, '7d', now).map((sample) => sample.count), [110, 120]);
});

test('날짜 기준 표시는 각 로컬 날짜의 마지막 값만 자정 위치에 둔다', () => {
  const history = [
    { at: new Date(2026, 6, 30, 9, 0).toISOString(), count: 100 },
    { at: new Date(2026, 6, 30, 21, 0).toISOString(), count: 115 },
    { at: new Date(2026, 6, 31, 18, 0).toISOString(), count: 130 }
  ];
  const collapsed = collapseSamplesByLocalDate(history);

  assert.deepEqual(collapsed.map((sample) => sample.count), [115, 130]);
  assert.deepEqual(collapsed.map((sample) => new Date(sample.timestamp).getHours()), [0, 0]);
});

test('구독자 선형 추세와 기간 요약을 계산한다', () => {
  const samples = [
    { at: '2026-07-01T00:00:00.000Z', count: 100 },
    { at: '2026-07-02T00:00:00.000Z', count: 110 },
    { at: '2026-07-03T00:00:00.000Z', count: 120 }
  ];

  const trend = linearRegression(samples);
  const summary = summarizeSamples(samples);

  assert.equal(trend.slopePerDay, 10);
  assert.deepEqual(trend.values, [100, 110, 120]);
  assert.deepEqual(summary, {
    current: 120,
    change: 20,
    high: 120,
    low: 100,
    slopePerDay: 10
  });
});

test('보유 기록이 짧으면 모든 기간의 축이 최초 수집일에서 시작한다', () => {
  const now = new Date(2026, 7, 1, 15, 0, 0, 0).getTime();
  const samples = [
    { at: new Date(2026, 6, 28, 5, 48, 0, 0).toISOString(), count: 100 },
    { at: new Date(2026, 7, 1, 10, 30, 0, 0).toISOString(), count: 130 }
  ];

  for (const range of ['7d', '30d', '90d', '1y', 'all']) {
    const axis = buildTimeAxis(samples, range, now);
    const start = new Date(axis.startTime);
    assert.deepEqual(
      [start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes()],
      [2026, 6, 28, 0, 0]
    );
    assert.equal(axis.endTime, now);
  }
});

test('날짜 눈금선은 해당 날짜의 현지시간 00시를 정확히 가리킨다', () => {
  const now = new Date(2026, 7, 1, 15, 0, 0, 0).getTime();
  const samples = [
    { at: new Date(2026, 6, 28, 5, 48, 0, 0).toISOString(), count: 100 },
    { at: new Date(2026, 7, 1, 10, 30, 0, 0).toISOString(), count: 130 }
  ];
  const axis = buildTimeAxis(samples, '1y', now);

  assert.deepEqual(
    axis.ticks.map((tick) => {
      const date = new Date(tick);
      return [date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
    }),
    [
      [7, 28, 0, 0],
      [7, 29, 0, 0],
      [7, 30, 0, 0],
      [7, 31, 0, 0],
      [8, 1, 0, 0]
    ]
  );
});

test('보유 기간이 길어지면 현지 자정 기준의 읽기 좋은 고정 간격을 사용한다', () => {
  const now = new Date(2026, 7, 1, 15, 0, 0, 0).getTime();
  const samples = [
    { at: new Date(2026, 5, 30, 5, 48, 0, 0).toISOString(), count: 100 },
    { at: new Date(2026, 7, 1, 10, 30, 0, 0).toISOString(), count: 130 }
  ];
  const axis = buildTimeAxis(samples, '90d', now);

  assert.ok(axis.ticks.length >= 6);
  for (const tick of axis.ticks) {
    const date = new Date(tick);
    assert.equal(date.getHours(), 0);
    assert.equal(date.getMinutes(), 0);
  }
  assert.deepEqual(
    axis.ticks.slice(1).map((tick, index) => (tick - axis.ticks[index]) / DAY_MS),
    Array(axis.ticks.length - 1).fill(5)
  );
});

test('하루의 마지막 기록으로 일별 증가량과 성장률을 계산한다', () => {
  const samples = [
    { at: new Date(2026, 6, 28, 5, 48).toISOString(), count: 100 },
    { at: new Date(2026, 6, 28, 20, 10).toISOString(), count: 105 },
    { at: new Date(2026, 6, 30, 18, 0).toISOString(), count: 125 }
  ];
  const daily = buildDailySeries(samples);

  assert.equal(daily.length, 2);
  assert.equal(daily[0].count, 105);
  assert.equal(daily[0].dailyChange, null);
  assert.equal(daily[1].elapsedDays, 2);
  assert.equal(daily[1].rawChange, 20);
  assert.equal(daily[1].dailyChange, 10);
  assert.ok(Math.abs(daily[1].growthRate - (20 / 105 / 2) * 100) < 1e-10);
});

test('둔화, 3일 모멘텀과 기간 전후반 기울기 변화를 계산한다', () => {
  const counts = [100, 110, 125, 137, 145, 150, 152];
  const samples = counts.map((count, index) => ({
    at: new Date(2026, 6, 20 + index, 20, 0).toISOString(),
    count
  }));
  const analysis = analyzeGrowth(samples);

  assert.equal(analysis.latestDailyChange, 2);
  assert.ok(Math.abs(analysis.latestGrowthRate - (2 / 150) * 100) < 1e-10);
  assert.equal(analysis.accelerationChange, -3);
  assert.ok(Math.abs(analysis.previousMomentum - (10 + 15 + 12) / 3) < 1e-10);
  assert.equal(analysis.recentMomentum, 5);
  assert.ok(Math.abs(analysis.momentumChange - (5 - (10 + 15 + 12) / 3)) < 1e-10);
  assert.ok(Number.isFinite(analysis.earlierSlope));
  assert.ok(Number.isFinite(analysis.laterSlope));
  assert.ok(analysis.slopeChange < 0);
});

test('완료되지 않은 오늘 기록은 성장 분석에서 제외한다', () => {
  const now = new Date(2026, 7, 1, 15, 0).getTime();
  const samples = [
    { at: new Date(2026, 6, 29, 20, 0).toISOString(), count: 100 },
    { at: new Date(2026, 6, 30, 20, 0).toISOString(), count: 110 },
    { at: new Date(2026, 6, 31, 20, 0).toISOString(), count: 125 },
    { at: new Date(2026, 7, 1, 14, 0).toISOString(), count: 999 }
  ];
  const analysis = analyzeGrowth(samples, now);

  assert.deepEqual(analysis.daily.map((sample) => sample.count), [100, 110, 125]);
  assert.equal(analysis.latestDailyChange, 15);
  assert.equal(analysis.excludedCurrentDay, true);
  assert.equal(analysis.latestCompletedAt, new Date(2026, 6, 31, 0, 0).getTime());
});

test('기간 밖 직전 마감값으로 첫 표시일 변화와 7일 모멘텀을 계산한다', () => {
  const now = new Date(2026, 7, 1, 15, 0).getTime();
  const counts = [100, 110, 120, 130, 140, 150, 160, 999];
  const history = counts.map((count, index) => ({
    at: new Date(2026, 6, 25 + index, 20, 0).toISOString(),
    count
  }));
  const analysis = analyzeGrowthForRange(history, '7d', now);
  const firstDay = analysis.daily[0].dayTimestamp;
  const firstDaySummary = summarizeDailyRange(analysis.daily, firstDay, firstDay);

  assert.deepEqual(analysis.daily.map((sample) => sample.count), [110, 120, 130, 140, 150, 160]);
  assert.equal(analysis.daily[0].rawChange, 10);
  assert.equal(analysis.previousMomentum, 10);
  assert.equal(analysis.recentMomentum, 10);
  assert.equal(analysis.momentumChange, 0);
  assert.equal(firstDaySummary.totalChange, 10);
});

test('성장 차트 축은 오늘을 넣지 않고 마지막 완료일에서 끝난다', () => {
  const now = new Date(2026, 7, 1, 15, 0).getTime();
  const history = [
    { at: new Date(2026, 6, 29, 20, 0).toISOString(), count: 100 },
    { at: new Date(2026, 6, 30, 20, 0).toISOString(), count: 110 },
    { at: new Date(2026, 6, 31, 20, 0).toISOString(), count: 120 },
    { at: new Date(2026, 7, 1, 14, 0).toISOString(), count: 999 }
  ];
  const analysis = analyzeGrowthForRange(history, '7d', now);
  const axis = buildCompletedDayAxis(analysis.daily);
  const lastCompleted = new Date(2026, 6, 31, 0, 0).getTime();

  assert.equal(axis.endTime, lastCompleted);
  assert.equal(axis.ticks.at(-1), lastCompleted);
  assert.ok(axis.ticks.every((tick) => tick < new Date(2026, 7, 1, 0, 0).getTime()));
});

test('클릭하거나 드래그한 완료일 구간의 평균과 성장률을 요약한다', () => {
  const counts = [100, 110, 130, 145, 165];
  const daily = buildDailySeries(counts.map((count, index) => ({
    at: new Date(2026, 6, 27 + index, 20, 0).toISOString(),
    count
  })));
  const summary = summarizeDailyRange(
    daily,
    new Date(2026, 6, 29, 0, 0).getTime(),
    new Date(2026, 6, 31, 0, 0).getTime()
  );

  assert.equal(summary.dayCount, 3);
  assert.equal(summary.totalChange, 55);
  assert.ok(Math.abs(summary.averageDailyChange - (20 + 15 + 20) / 3) < 1e-10);
  assert.ok(Math.abs(summary.averageGrowthRate - ((20 / 110) + (15 / 130) + (20 / 145)) / 3 * 100) < 1e-10);
  assert.equal(summary.periodGrowthRate, 50);
  assert.ok(Math.abs(summary.slopePerDay - 17.5) < 1e-10);
});

test('확대 구간은 구간 안 기록만 표시하고 성장 계산에는 직전 기록 하나를 숨은 기준값으로 둔다', () => {
  const history = [
    { at: new Date(2026, 6, 25, 20, 0).toISOString(), count: 100 },
    { at: new Date(2026, 6, 26, 8, 0).toISOString(), count: 105 },
    { at: new Date(2026, 6, 26, 20, 0).toISOString(), count: 110 },
    { at: new Date(2026, 6, 27, 20, 0).toISOString(), count: 125 },
    { at: new Date(2026, 6, 28, 20, 0).toISOString(), count: 140 }
  ];
  const startTime = new Date(2026, 6, 26, 12, 0).getTime();
  const endTime = new Date(2026, 6, 27, 23, 0).getTime();

  assert.deepEqual(
    filterSamplesInTimeWindow(history, startTime, endTime).map((sample) => sample.count),
    [110, 125]
  );
  assert.deepEqual(
    filterSamplesWithBaselineInTimeWindow(history, startTime, endTime).map((sample) => sample.count),
    [105, 110, 125]
  );

  const analysis = analyzeGrowthForTimeWindow(
    history,
    startTime,
    endTime,
    new Date(2026, 6, 29, 15, 0).getTime()
  );
  assert.deepEqual(analysis.daily.map((sample) => sample.count), [110, 125]);
  assert.equal(analysis.daily[0].rawChange, 10);
  assert.equal(analysis.daily[1].rawChange, 15);
});

test('확대된 시간축은 화면 구간 안의 현지 자정만 눈금으로 사용한다', () => {
  const startTime = new Date(2026, 6, 26, 12, 0).getTime();
  const endTime = new Date(2026, 6, 29, 6, 0).getTime();
  const axis = buildTimeWindowAxis(startTime, endTime);

  assert.equal(axis.startTime, startTime);
  assert.equal(axis.endTime, endTime);
  assert.deepEqual(
    axis.ticks.map((tick) => {
      const date = new Date(tick);
      return [date.getDate(), date.getHours(), date.getMinutes()];
    }),
    [[27, 0, 0], [28, 0, 0], [29, 0, 0]]
  );
});

test('휠 확대는 커서가 가리킨 시점을 같은 비율에 유지하고 축소는 전체 범위에서 멈춘다', () => {
  const fullWindow = { startTime: 0, endTime: 10 * DAY_MS };
  const zoomed = zoomTimeWindow(fullWindow, fullWindow, 2.5 * DAY_MS, 0.5, DAY_MS);

  assert.equal(zoomed.endTime - zoomed.startTime, 5 * DAY_MS);
  assert.equal((2.5 * DAY_MS - zoomed.startTime) / (zoomed.endTime - zoomed.startTime), 0.25);
  assert.deepEqual(
    zoomTimeWindow(zoomed, fullWindow, 2.5 * DAY_MS, 10, DAY_MS),
    fullWindow
  );
});
