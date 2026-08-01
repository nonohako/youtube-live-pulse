'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTimeAxis,
  filterSamples,
  linearRegression,
  normalizeSamples,
  summarizeSamples
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

test('7일·30일·90일 가로축은 일정한 날짜 간격으로 나눈다', () => {
  const now = new Date('2026-08-01T12:00:00.000Z').getTime();
  const expectations = [
    ['7d', 8, 1],
    ['30d', 7, 5],
    ['90d', 7, 15]
  ];

  for (const [range, tickCount, intervalDays] of expectations) {
    const axis = buildTimeAxis([], range, now);
    assert.equal(axis.ticks.length, tickCount);
    assert.deepEqual(
      axis.ticks.slice(1).map((tick, index) => (tick - axis.ticks[index]) / DAY_MS),
      Array(tickCount - 1).fill(intervalDays)
    );
  }
});

test('1년 가로축은 3개월 단위로 표시한다', () => {
  const now = new Date('2026-08-01T12:00:00.000Z').getTime();
  const axis = buildTimeAxis([], '1y', now);
  assert.deepEqual(
    axis.ticks.map((tick) => new Date(tick).toISOString().slice(0, 10)),
    ['2025-08-01', '2025-11-01', '2026-02-01', '2026-05-01', '2026-08-01']
  );
});

test('전체 가로축도 기록 개수와 무관하게 같은 화면 간격으로 나눈다', () => {
  const samples = [
    { at: '2026-01-01T00:00:00.000Z', count: 100 },
    { at: '2026-01-02T00:00:00.000Z', count: 110 },
    { at: '2026-07-01T00:00:00.000Z', count: 130 }
  ];
  const axis = buildTimeAxis(samples, 'all');
  const intervals = axis.ticks.slice(1).map((tick, index) => tick - axis.ticks[index]);

  assert.equal(axis.ticks.length, 7);
  assert.equal(new Set(intervals).size, 1);
});
