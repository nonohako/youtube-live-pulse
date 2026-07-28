'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  filterSamples,
  linearRegression,
  normalizeSamples,
  summarizeSamples
} = require('../src/renderer/chart-math');

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
