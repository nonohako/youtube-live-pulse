'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractBalancedObject,
  extractHandle,
  findChannelId,
  normalizeChannelId,
  parseInitialData,
  parseChannelMetadata,
  parseLocalizedCount,
  parsePlayerBroadcast,
  parsePostsFromInitialData,
  parseVideoFeed,
  parseVideosFromInitialData,
  safeVideoIdFromUrl
} = require('../src/lib/youtube');

const CHANNEL_ID = 'UCtKtCiaWRz-d3EZn2xd1mdA';

test('채널 ID와 핸들 입력을 안전하게 판별한다', () => {
  assert.deepEqual(normalizeChannelId(CHANNEL_ID), {
    id: CHANNEL_ID,
    url: `https://www.youtube.com/channel/${CHANNEL_ID}`
  });
  assert.equal(extractHandle('@sample.channel'), '@sample.channel');
  assert.equal(extractHandle('https://www.youtube.com/@sample.channel/videos'), '@sample.channel');
  assert.equal(extractHandle('https://example.com/@sample.channel'), null);
  assert.throws(() => normalizeChannelId('not-a-channel'));
});

test('HTML에서 채널 ID를 추출한다', () => {
  assert.equal(findChannelId(`<script>{"externalId":"${CHANNEL_ID}"}</script>`), CHANNEL_ID);
  assert.equal(findChannelId(`<meta itemprop="channelId" content="${CHANNEL_ID}">`), CHANNEL_ID);
});

test('문자열 중괄호가 포함된 초기 JSON도 정확히 분리한다', () => {
  const source = 'prefix {"title":"brace } and \\" quote","nested":{"ok":true}}; suffix';
  assert.equal(
    extractBalancedObject(source, source.indexOf('{')),
    '{"title":"brace } and \\" quote","nested":{"ok":true}}'
  );
  const parsed = parseInitialData(`var ytInitialData = ${extractBalancedObject(source, source.indexOf('{'))};`);
  assert.equal(parsed.nested.ok, true);
});

test('라이브, 예약 방송, 일반 영상을 렌더러에서 구분한다', () => {
  const data = {
    contents: [
      {
        videoRenderer: {
          videoId: 'abcdefghijk',
          title: { runs: [{ text: '현재 라이브' }] },
          thumbnail: { thumbnails: [{ url: 'https://img/live.jpg', width: 320 }] },
          thumbnailOverlays: [
            { thumbnailOverlayTimeStatusRenderer: { style: 'LIVE', text: { simpleText: 'LIVE' } } }
          ]
        }
      },
      {
        gridVideoRenderer: {
          videoId: 'lmnopqrstuv',
          title: { simpleText: '예약 방송' },
          upcomingEventData: { startTime: '4102444800' },
          thumbnailOverlays: []
        }
      },
      {
        videoRenderer: {
          videoId: '12345678901',
          title: { simpleText: '일반 영상' },
          publishedTimeText: { simpleText: '1시간 전' }
        }
      }
    ]
  };

  const videos = parseVideosFromInitialData(data);
  assert.equal(videos[0].isLive, true);
  assert.equal(videos[1].isUpcoming, true);
  assert.equal(videos[1].scheduledStart, '2100-01-01T00:00:00.000Z');
  assert.equal(videos[2].isLive, false);
  assert.equal(videos[2].isUpcoming, false);
});

test('플레이어 응답에서 현재 라이브와 예약 방송을 파싱한다', () => {
  const livePlayer = {
    videoDetails: {
      videoId: 'abcdefghijk',
      title: '테스트 라이브',
      isLive: true,
      isLiveContent: true,
      thumbnail: { thumbnails: [{ url: 'https://img/live.jpg', width: 320 }] }
    },
    microformat: {
      playerMicroformatRenderer: {
        liveBroadcastDetails: {
          isLiveNow: true,
          startTimestamp: '2026-07-28T12:00:00Z'
        }
      }
    }
  };
  const parsed = parsePlayerBroadcast(`var ytInitialPlayerResponse = ${JSON.stringify(livePlayer)};`);
  assert.equal(parsed.id, 'abcdefghijk');
  assert.equal(parsed.isLive, true);
  assert.equal(parsed.isUpcoming, false);
});

test('시작 시각이 없거나 이미 지난 라이브를 예약 방송으로 분류하지 않는다', () => {
  const basePlayer = {
    videoDetails: {
      videoId: 'abcdefghijk',
      title: '종료된 라이브',
      isLiveContent: true
    },
    microformat: {
      playerMicroformatRenderer: {
        liveBroadcastDetails: {
          isLiveNow: false
        }
      }
    }
  };
  const withoutStart = parsePlayerBroadcast(
    `var ytInitialPlayerResponse = ${JSON.stringify(basePlayer)};`
  );
  assert.equal(withoutStart, null);

  basePlayer.microformat.playerMicroformatRenderer.liveBroadcastDetails.startTimestamp =
    '2020-01-01T00:00:00Z';
  const pastStart = parsePlayerBroadcast(
    `var ytInitialPlayerResponse = ${JSON.stringify(basePlayer)};`
  );
  assert.equal(pastStart, null);
});

test('미래 시작 시각이 있는 라이브 콘텐츠만 예약 방송으로 분류한다', () => {
  const upcomingPlayer = {
    videoDetails: {
      videoId: 'abcdefghijk',
      title: '예약 라이브',
      isLiveContent: true
    },
    microformat: {
      playerMicroformatRenderer: {
        liveBroadcastDetails: {
          isLiveNow: false,
          startTimestamp: '2100-01-01T00:00:00Z'
        }
      }
    }
  };
  const parsed = parsePlayerBroadcast(
    `var ytInitialPlayerResponse = ${JSON.stringify(upcomingPlayer)};`
  );
  assert.equal(parsed.isUpcoming, true);
  assert.equal(parsed.scheduledStart, '2100-01-01T00:00:00Z');
});

test('게시물과 RSS 피드를 파싱한다', () => {
  const posts = parsePostsFromInitialData({
    item: {
      backstagePostRenderer: {
        postId: 'Ugkx-post',
        contentText: { runs: [{ text: '새 소식입니다' }] },
        publishedTimeText: { simpleText: '2시간 전' }
      }
    }
  });
  assert.equal(posts[0].text, '새 소식입니다');
  assert.match(posts[0].url, /\/post\/Ugkx-post$/);

  const feed = parseVideoFeed(`
    <feed>
      <entry>
        <yt:videoId>abcdefghijk</yt:videoId>
        <title>Rock &amp; Roll</title>
        <published>2026-07-28T10:00:00+00:00</published>
        <media:thumbnail url="https://img.example/thumb.jpg"/>
      </entry>
    </feed>`);
  assert.equal(feed[0].title, 'Rock & Roll');
  assert.equal(feed[0].id, 'abcdefghijk');
});

test('한글과 영문 축약 구독자 수를 숫자로 바꾼다', () => {
  assert.equal(parseLocalizedCount('구독자 1.23만명'), 12_300);
  assert.equal(parseLocalizedCount('1.5M subscribers'), 1_500_000);
  assert.equal(parseLocalizedCount('구독자 987명'), 987);
  assert.equal(parseLocalizedCount('비공개'), null);
});

test('새 채널 헤더의 content 필드에서도 구독자 수를 찾는다', () => {
  const metadata = parseChannelMetadata({
    header: {
      pageHeaderViewModel: {
        metadata: [
          { text: { content: '동영상 1.6천개' } },
          { text: { content: '구독자 85.5만명' } }
        ]
      }
    }
  });
  assert.equal(metadata.subscriberText, '구독자 85.5만명');
  assert.equal(metadata.subscriberCount, 855_000);
});

test('YouTube URL에서만 안전한 영상 ID를 허용한다', () => {
  assert.equal(safeVideoIdFromUrl('https://www.youtube.com/watch?v=abcdefghijk'), 'abcdefghijk');
  assert.equal(safeVideoIdFromUrl('https://example.com/watch?v=abcdefghijk'), null);
  assert.equal(safeVideoIdFromUrl('javascript:alert(1)'), null);
});
