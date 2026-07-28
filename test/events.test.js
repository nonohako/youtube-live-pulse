'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dedupeEvents, eventDedupKey } = require('../src/lib/events');
const { findUnseenItems, uniqueContentItems } = require('../src/lib/monitor');

test('같은 채널·유형·URL의 기존 알림은 최신 한 건만 남긴다', () => {
  const events = [
    {
      id: 'newer',
      channelId: 'channel-a',
      type: 'video',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      detail: '영상 A'
    },
    {
      id: 'older',
      channelId: 'channel-a',
      type: 'video',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      detail: '영상 A'
    },
    {
      id: 'other',
      channelId: 'channel-a',
      type: 'video',
      url: 'https://www.youtube.com/watch?v=lmnopqrstuv',
      detail: '영상 B'
    }
  ];

  assert.deepEqual(dedupeEvents(events).map((event) => event.id), ['newer', 'other']);
  assert.equal(eventDedupKey(events[0]), eventDedupKey(events[1]));
});

test('피드 순서가 바뀌어도 이미 본 영상은 새 알림으로 반환하지 않는다', () => {
  const reordered = [
    { id: 'video-b', title: '영상 B' },
    { id: 'video-a', title: '영상 A' }
  ];

  assert.deepEqual(findUnseenItems(reordered, new Set(['video-a', 'video-b'])), []);
  assert.deepEqual(
    findUnseenItems([{ id: 'video-c' }, ...reordered], new Set(['video-a', 'video-b']))
      .map((item) => item.id),
    ['video-c']
  );
});

test('첫 확인은 최근 항목을 기준선으로만 저장하고 알리지 않는다', () => {
  const items = [{ id: 'video-a' }, { id: 'video-b' }];
  assert.deepEqual(findUnseenItems(items, new Set(), false), []);
});

test('한 응답 안의 중복 콘텐츠 ID도 한 번만 처리한다', () => {
  assert.deepEqual(
    uniqueContentItems([{ id: 'a' }, { id: 'a' }, null, { id: 'b' }]).map((item) => item.id),
    ['a', 'b']
  );
});
