'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractSubscriberRecords,
  loadSubscriberRecords,
  localDateKey,
  mergeSubscriberHistory,
  parseDateParts,
  parseSubscriberCount
} = require('../src/lib/subscriber-import');

test('예시 형식에서 날짜별 전체 구독자 수만 읽는다', () => {
  const result = extractSubscriberRecords([{ sheet: 'Sheet1', data: [
    ['날짜', '신규 구독자', '전체 구독자'],
    ['합계', 641000, '-'],
    ['평균', 1756, '-'],
    ['2025.08.02', '-', 241000],
    ['2025.08.03', '-', '242,000'],
    ['잘못된 날짜', 1000, 243000]
  ] }]);

  assert.equal(result.matchedSheets, 1);
  assert.equal(result.invalidRows, 1);
  assert.deepEqual(result.records.map(({ dateKey, count }) => ({ dateKey, count })), [
    { dateKey: '2025-08-02', count: 241000 },
    { dateKey: '2025-08-03', count: 242000 }
  ]);
});

test('같은 날짜가 파일에 여러 번 있으면 마지막 값을 한 건으로 읽는다', () => {
  const result = extractSubscriberRecords([
    { sheet: '안내', data: [['이 시트는 건너뜁니다']] },
    { sheet: '기록', data: [
      ['날짜', '전체 구독자'],
      ['2026-07-31', 1560000],
      ['2026/07/31', 1570000]
    ] }
  ]);

  assert.equal(result.duplicateRows, 1);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].count, 1570000);
});

test('기존 로컬 날짜는 건너뛰고 새 날짜를 00시에 정렬해 추가한다', () => {
  const existingAt = new Date(2026, 6, 31, 18, 25).toISOString();
  const imported = [
    { dateKey: '2026-07-30', at: new Date(2026, 6, 30).toISOString(), count: 1550000 },
    { dateKey: '2026-07-31', at: new Date(2026, 6, 31).toISOString(), count: 1560000 }
  ];

  const result = mergeSubscriberHistory([{ at: existingAt, count: 1570000 }], imported);

  assert.equal(result.added, 1);
  assert.equal(result.skippedExisting, 1);
  assert.deepEqual(result.history.map((sample) => localDateKey(sample.at)), [
    '2026-07-30',
    '2026-07-31'
  ]);
  assert.equal(new Date(result.history[0].at).getHours(), 0);
  assert.equal(result.history[1].count, 1570000);
});

test('xlsx 이외의 파일은 열기 전에 거부한다', async () => {
  await assert.rejects(
    () => loadSubscriberRecords('history.csv'),
    /\.xlsx 형식/
  );
});

test('날짜와 구독자 수 입력을 엄격하게 검증한다', () => {
  assert.deepEqual(parseDateParts('2026.02.28'), { year: 2026, month: 2, day: 28 });
  assert.deepEqual(parseDateParts(new Date(Date.UTC(2026, 6, 31))), { year: 2026, month: 7, day: 31 });
  assert.equal(parseDateParts('2026.02.30'), null);
  assert.equal(parseSubscriberCount('1,580,000'), 1580000);
  assert.equal(parseSubscriberCount('-'), null);
  assert.equal(parseSubscriberCount(-1), null);
});
