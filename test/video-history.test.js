'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_VIDEO_SAMPLES,
  VIDEO_HISTORY_HEARTBEAT_MS,
  compactSamples,
  mergeVideoViewStatistics,
  normalizeVideoViewHistories
} = require('../src/lib/video-history');

test('새 영상 조회수를 안전한 메타데이터와 첫 표본으로 저장한다', () => {
  const checkedAt = '2026-08-11T12:07:35.000Z';
  const histories = mergeVideoViewStatistics([], [{
    id: 'abcdefghijk',
    title: '새 영상',
    thumbnailUrl: 'https://img.example/video.jpg',
    publishedAt: '2026-08-11T12:00:29.000Z',
    viewCount: 102_886,
    source: 'api'
  }], checkedAt);

  assert.equal(histories.length, 1);
  assert.equal(histories[0].videoId, 'abcdefghijk');
  assert.equal(histories[0].url, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(histories[0].samples[0].count, 102_886);
  assert.equal(histories[0].source, 'api');
});

test('조회수가 바뀌면 표본을 추가하고 같은 값은 6시간 심박 전까지 반복 저장하지 않는다', () => {
  const firstAt = new Date('2026-08-11T00:00:00.000Z').getTime();
  let histories = mergeVideoViewStatistics([], [{ id: 'abcdefghijk', viewCount: 100 }], firstAt);
  histories = mergeVideoViewStatistics(histories, [{ id: 'abcdefghijk', viewCount: 100 }], firstAt + 60_000);
  assert.equal(histories[0].samples.length, 1);

  histories = mergeVideoViewStatistics(histories, [{ id: 'abcdefghijk', viewCount: 120 }], firstAt + 120_000);
  assert.deepEqual(histories[0].samples.map((sample) => sample.count), [100, 120]);

  histories = mergeVideoViewStatistics(
    histories,
    [{ id: 'abcdefghijk', viewCount: 120 }],
    firstAt + 120_000 + VIDEO_HISTORY_HEARTBEAT_MS
  );
  assert.equal(histories[0].samples.length, 3);
});

test('기존 저장 파일의 잘못된 영상 ID, 표본과 안전하지 않은 URL을 정리한다', () => {
  const histories = normalizeVideoViewHistories([
    { videoId: 'bad', samples: [{ at: '2026-08-11T00:00:00Z', count: 1 }] },
    {
      videoId: 'abcdefghijk',
      title: '정상 영상',
      thumbnailUrl: 'javascript:alert(1)',
      samples: [
        { at: 'invalid', count: 999 },
        { at: '2026-08-11T00:00:00Z', count: '100' }
      ]
    }
  ]);

  assert.equal(histories.length, 1);
  assert.equal(histories[0].thumbnailUrl, '');
  assert.deepEqual(histories[0].samples.map((sample) => sample.count), [100]);
});

test('표본 상한을 넘으면 전체 수집 기간의 첫 값과 마지막 값을 보존해 압축한다', () => {
  const samples = Array.from({ length: MAX_VIDEO_SAMPLES + 5 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    timestamp: Date.UTC(2026, 0, 1, 0, index),
    count: index
  }));
  const compacted = compactSamples(samples, MAX_VIDEO_SAMPLES);

  assert.equal(compacted.length, MAX_VIDEO_SAMPLES);
  assert.equal(compacted[0].count, 0);
  assert.equal(compacted.at(-1).count, samples.at(-1).count);
});

test('1년 보존 기간보다 오래된 조회수 표본과 빈 영상 이력을 제거한다', () => {
  const now = new Date('2026-08-11T12:00:00Z').getTime();
  const histories = normalizeVideoViewHistories([{
    videoId: 'abcdefghijk',
    samples: [
      { at: '2025-01-01T00:00:00Z', count: 10 },
      { at: '2026-08-10T00:00:00Z', count: 20 }
    ]
  }, {
    videoId: 'lmnopqrstuv',
    samples: [{ at: '2024-01-01T00:00:00Z', count: 30 }]
  }], now);

  assert.equal(histories.length, 1);
  assert.deepEqual(histories[0].samples.map((sample) => sample.count), [20]);
});
