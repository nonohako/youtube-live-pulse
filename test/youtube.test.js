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
  parseVideoStatistics,
  parsePostsFromInitialData,
  parseVideoFeed,
  parseVideosFromInitialData,
  safeVideoIdFromUrl,
  selectLiveBroadcast,
  selectRecentVideos
} = require('../src/lib/youtube');

const CHANNEL_ID = 'UCtKtCiaWRz-d3EZn2xd1mdA';

test('실제 쇼츠 카드와 구형 reel 카드를 읽고 중복 및 잘못된 ID를 제거한다', () => {
  const fixture = require('./fixtures/shorts-lockup.json');
  const videos = parseVideosFromInitialData([fixture, fixture, {
    reelItemRenderer: { videoId: 'abcdefghijk', headline: { simpleText: '구형 쇼츠' } }
  }, { shortsLockupViewModel: { videoId: 'invalid' } }]);
  assert.equal(videos.length, 2);
  assert.equal(videos[0].id, 'mFM2hP5LEhM');
  assert.equal(videos[0].title, '스팸 원이 에디션(?)');
  assert.equal(videos[0].viewCount, 300000);
  assert.equal(videos[0].isLive, false);
  assert.equal(videos[1].title, '구형 쇼츠');
});

test('RSS에 없는 쇼츠도 일반 영상 8개에 밀리지 않으며 중복 라이브는 제외한다', () => {
  const uploads = Array.from({ length: 12 }, (_, i) => ({ id: `upload${i}` }));
  const shorts = parseVideosFromInitialData(require('./fixtures/shorts-lockup.json'));
  const recent = selectRecentVideos(uploads, [{ id: 'live' }], [{ id: 'live', isLive: true }], 32, shorts);
  assert.ok(recent.some((video) => video.id === 'mFM2hP5LEhM'));
  assert.ok(!recent.some((video) => video.id === 'live'));
  assert.equal(recent.length, 9);
});

test('RSS 실패 중에도 스냅샷이 shorts 탭에서 영상을 감지한다', async (t) => {
  const requested = [];
  const fixture = require('./fixtures/shorts-lockup.json');
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    if (String(url).includes('/feeds/')) throw new Error('RSS unavailable');
    return { ok: true, url: String(url), text: async () => `var ytInitialData = ${JSON.stringify(String(url).endsWith('/shorts') ? fixture : {})};` };
  });
  const snapshot = await require('../src/lib/youtube').fetchChannelSnapshot({ id: CHANNEL_ID });
  assert.ok(requested.some((url) => url.endsWith('/shorts')));
  assert.equal(snapshot.latestVideo.id, 'mFM2hP5LEhM');
  assert.equal(snapshot.recentVideos.length, 1);
  assert.ok(snapshot.warnings.length > 0);
});

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

test('새 lockup 동영상 카드에서 영상 ID, 조회수와 게시 시각을 읽는다', () => {
  const data = {
    richItemRenderer: {
      content: {
        lockupViewModel: {
          contentId: 'abcdefghijk',
          contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
          contentImage: {
            thumbnailViewModel: {
              image: { sources: [{ url: 'https://img/video.jpg', width: 336 }] },
              overlays: [{
                thumbnailBottomOverlayViewModel: {
                  badges: [{
                    thumbnailBadgeViewModel: {
                      text: '12:34',
                      badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT'
                    }
                  }]
                }
              }]
            }
          },
          metadata: {
            lockupMetadataViewModel: {
              title: { content: '새 일반 영상' },
              metadata: {
                contentMetadataViewModel: {
                  metadataRows: [{ metadataParts: [
                    { text: { content: '조회수 15만회' } },
                    { text: { content: '8분 전' } }
                  ] }]
                }
              }
            }
          },
          rendererContext: {
            commandContext: {
              onTap: { innertubeCommand: { watchEndpoint: { videoId: 'abcdefghijk' } } }
            }
          }
        }
      }
    }
  };

  const [video] = parseVideosFromInitialData(data);
  assert.equal(video.id, 'abcdefghijk');
  assert.equal(video.title, '새 일반 영상');
  assert.equal(video.viewCount, 150_000);
  assert.equal(video.publishedText, '8분 전');
  assert.equal(video.isLive, false);
  assert.equal(video.isUpcoming, false);
});

test('새 lockup 방송 카드에서 현재 라이브와 미래 예약만 구분한다', () => {
  const lockup = (id, badge, startTimeSeconds = null) => ({
    lockupViewModel: {
      contentId: id,
      contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
      contentImage: {
        thumbnailViewModel: {
          image: { sources: [] },
          overlays: [{ thumbnailBottomOverlayViewModel: { badges: [
            { thumbnailBadgeViewModel: badge }
          ] } }]
        }
      },
      metadata: { lockupMetadataViewModel: { title: { content: id } } },
      rendererContext: {
        commandContext: {
          onTap: { innertubeCommand: { watchEndpoint: { videoId: id, startTimeSeconds } } }
        }
      }
    }
  });
  const data = {
    contents: [
      lockup('abcdefghijk', {
        text: '실시간',
        badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE'
      }),
      lockup('lmnopqrstuv', {
        text: '공개 예정',
        badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_UPCOMING'
      }, '4102444800'),
      lockup('12345678901', {
        text: '공개 예정',
        badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_UPCOMING'
      }, '1577836800')
    ]
  };

  const videos = parseVideosFromInitialData(data);
  assert.equal(videos[0].isLive, true);
  assert.equal(videos[1].isUpcoming, true);
  assert.equal(videos[1].scheduledStart, '2100-01-01T00:00:00.000Z');
  assert.equal(videos[2].isUpcoming, false);
});

test('예약 배지만 있고 실제 미래 시작 시각이 없으면 예약 방송으로 열지 않는다', () => {
  const [legacy, lockup] = parseVideosFromInitialData({
    contents: [
      {
        videoRenderer: {
          videoId: 'abcdefghijk',
          title: { simpleText: '시각 없는 기존 카드' },
          badges: [{ metadataBadgeRenderer: { label: 'UPCOMING' } }]
        }
      },
      {
        lockupViewModel: {
          contentId: 'lmnopqrstuv',
          contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
          contentImage: {
            thumbnailViewModel: {
              overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{
                thumbnailBadgeViewModel: {
                  text: '공개 예정',
                  badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_UPCOMING'
                }
              }] } }]
            }
          },
          metadata: { lockupMetadataViewModel: { title: { content: '시각 없는 새 카드' } } }
        }
      }
    ]
  });

  assert.equal(legacy.isUpcoming, false);
  assert.equal(lockup.isUpcoming, false);
});

test('일반 영상 알림 후보에서 현재 라이브와 예약 방송을 제외하고 ID 중복을 제거한다', () => {
  const ordinary = { id: 'abcdefghijk', title: '일반 영상', isLive: false, isUpcoming: false };
  const live = { id: 'lmnopqrstuv', title: '라이브', isLive: true, isUpcoming: false };
  const upcoming = { id: '12345678901', title: '예약', isLive: false, isUpcoming: true };
  const recent = selectRecentVideos([ordinary, live, upcoming], [ordinary], [live]);

  assert.deepEqual(recent.map((video) => video.id), ['abcdefghijk']);
});

test('정상 응답한 live 재생기가 라이브가 아니면 목록의 라이브 배지만 믿지 않는다', () => {
  const pageLive = {
    id: 'abcdefghijk',
    title: '목록에만 남은 LIVE',
    isLive: true
  };
  assert.equal(selectLiveBroadcast(null, pageLive, true), null);
  assert.equal(selectLiveBroadcast(null, pageLive, false), pageLive);

  const playerLive = {
    id: 'abcdefghijk',
    title: '재생기로 확인한 LIVE',
    isLive: true,
    url: 'https://www.youtube.com/watch?v=abcdefghijk'
  };
  assert.equal(selectLiveBroadcast(playerLive, pageLive, true).title, '재생기로 확인한 LIVE');
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

test('공개 플레이어 응답에서 영상별 정확한 조회수와 게시 시각을 읽는다', () => {
  const player = {
    playabilityStatus: { status: 'OK' },
    videoDetails: {
      videoId: 'abcdefghijk',
      title: '조회수 영상',
      viewCount: '102886',
      thumbnail: { thumbnails: [{ url: 'https://img/video.jpg', width: 320 }] }
    },
    microformat: {
      playerMicroformatRenderer: {
        publishDate: '2026-08-11T05:00:29-07:00'
      }
    }
  };
  const parsed = parseVideoStatistics(
    `var ytInitialPlayerResponse = ${JSON.stringify(player)};`,
    'https://www.youtube.com/watch?v=abcdefghijk'
  );

  assert.equal(parsed.id, 'abcdefghijk');
  assert.equal(parsed.viewCount, 102_886);
  assert.equal(parsed.publishedAt, '2026-08-11T05:00:29-07:00');
  assert.equal(parsed.source, 'page');
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
