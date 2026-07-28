'use strict';

const YOUTUBE_ORIGIN = 'https://www.youtube.com';
const REQUEST_HEADERS = Object.freeze({
  'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36',
  cookie: 'SOCS=CAI'
});

class YouTubeRequestError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'YouTubeRequestError';
    this.status = status;
  }
}

async function resolveChannelInput(rawInput, apiKey = '') {
  const input = String(rawInput || '').trim();
  if (!input) throw new Error('채널 주소 또는 @핸들을 입력하세요.');

  const directId = input.match(/(?:^|\/)(UC[\w-]{22})(?:$|[/?#])/i)?.[1]
    || input.match(/^UC[\w-]{22}$/i)?.[0];
  if (directId) return normalizeChannelId(directId);

  const handle = extractHandle(input);
  if (!handle) {
    throw new Error('지원하는 형식: 채널 URL, @핸들, 또는 UC로 시작하는 채널 ID');
  }

  if (apiKey) {
    const endpoint = new URL('https://www.googleapis.com/youtube/v3/channels');
    endpoint.search = new URLSearchParams({
      part: 'id',
      forHandle: handle.slice(1),
      key: apiKey
    }).toString();
    const payload = await fetchJson(endpoint.toString());
    if (payload.items?.[0]?.id) return normalizeChannelId(payload.items[0].id);
  }

  const html = await fetchText(`${YOUTUBE_ORIGIN}/${encodeURIComponent(handle)}`);
  const id = findChannelId(html);
  if (!id) throw new Error('채널 ID를 찾지 못했습니다. 채널의 /channel/UC… 주소를 입력해 주세요.');
  return normalizeChannelId(id);
}

function normalizeChannelId(id) {
  const normalized = String(id);
  if (!/^UC[\w-]{22}$/.test(normalized)) throw new Error('올바르지 않은 YouTube 채널 ID입니다.');
  return {
    id: normalized,
    url: `${YOUTUBE_ORIGIN}/channel/${normalized}`
  };
}

function extractHandle(input) {
  if (/^@[\p{L}\p{N}_.-]+$/u.test(input)) return input;
  try {
    const candidate = new URL(input);
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(candidate.hostname.toLowerCase())) {
      return null;
    }
    const part = candidate.pathname.split('/').filter(Boolean)[0] || '';
    return part.startsWith('@') ? decodeURIComponent(part) : null;
  } catch {
    return null;
  }
}

function findChannelId(html) {
  const patterns = [
    /"externalId"\s*:\s*"(UC[\w-]{22})"/,
    /"channelId"\s*:\s*"(UC[\w-]{22})"/,
    /<meta\s+itemprop="channelId"\s+content="(UC[\w-]{22})"/i,
    /youtube\.com\/channel\/(UC[\w-]{22})/
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function fetchChannelSnapshot(channel, options = {}) {
  const channelUrl = `${YOUTUBE_ORIGIN}/channel/${channel.id}`;
  const tasks = {
    streams: fetchText(`${channelUrl}/streams`),
    posts: fetchText(`${channelUrl}/posts`),
    feed: fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`),
    live: fetchText(`${channelUrl}/live`, { includeFinalUrl: true })
  };

  if (options.apiKey && options.includeOfficialStats) {
    tasks.official = fetchOfficialChannel(channel.id, options.apiKey);
  }

  const names = Object.keys(tasks);
  const results = await Promise.allSettled(Object.values(tasks));
  const settled = Object.fromEntries(names.map((name, index) => [name, results[index]]));
  const warnings = [];

  const streamsHtml = settled.streams.status === 'fulfilled' ? settled.streams.value : '';
  const streamsData = streamsHtml ? parseInitialData(streamsHtml) : null;
  const videos = streamsData ? parseVideosFromInitialData(streamsData) : [];
  if (settled.streams.status === 'rejected') warnings.push(formatRequestWarning('방송 목록', settled.streams.reason));

  const postsHtml = settled.posts.status === 'fulfilled' ? settled.posts.value : '';
  const postsData = postsHtml ? parseInitialData(postsHtml) : null;
  const posts = postsData ? parsePostsFromInitialData(postsData) : [];
  if (settled.posts.status === 'rejected') warnings.push(formatRequestWarning('게시물', settled.posts.reason));

  const feed = settled.feed.status === 'fulfilled' ? parseVideoFeed(settled.feed.value) : [];
  if (settled.feed.status === 'rejected') warnings.push(formatRequestWarning('새 영상', settled.feed.reason));

  let playerBroadcast = null;
  if (settled.live.status === 'fulfilled') {
    const liveResult = settled.live.value;
    playerBroadcast = parsePlayerBroadcast(liveResult.body, liveResult.url);
  } else {
    warnings.push(formatRequestWarning('현재 라이브', settled.live.reason));
  }

  const scrapedMetadata = streamsData
    ? parseChannelMetadata(streamsData, streamsHtml)
    : parseChannelMetadata(null, streamsHtml);
  let metadata = scrapedMetadata;
  if (settled.official?.status === 'fulfilled') {
    metadata = { ...scrapedMetadata, ...settled.official.value, source: 'api' };
  } else if (settled.official?.status === 'rejected') {
    warnings.push(formatRequestWarning('공식 채널 통계', settled.official.reason));
  }

  const pageLive = videos.find((video) => video.isLive) || null;
  const live = playerBroadcast?.isLive
    ? mergeBroadcast(playerBroadcast, pageLive)
    : pageLive;

  const upcomingCandidates = videos
    .filter((video) => video.isUpcoming && (!live || video.id !== live.id))
    .sort((a, b) => dateValue(a.scheduledStart) - dateValue(b.scheduledStart));
  if (playerBroadcast?.isUpcoming && (!live || playerBroadcast.id !== live.id)) {
    upcomingCandidates.push(playerBroadcast);
    upcomingCandidates.sort((a, b) => dateValue(a.scheduledStart) - dateValue(b.scheduledStart));
  }

  return {
    checkedAt: new Date().toISOString(),
    metadata,
    live: live || null,
    upcoming: uniqueById(upcomingCandidates).slice(0, 5),
    latestVideo: feed[0] || videos.find((video) => !video.isLive && !video.isUpcoming) || null,
    latestPost: posts[0] || null,
    recentVideos: uniqueById([...feed, ...videos]).slice(0, 8),
    recentPosts: posts.slice(0, 8),
    warnings: warnings.filter(Boolean)
  };
}

async function fetchOfficialChannel(channelId, apiKey) {
  const endpoint = new URL('https://www.googleapis.com/youtube/v3/channels');
  endpoint.search = new URLSearchParams({
    part: 'snippet,statistics',
    id: channelId,
    key: apiKey
  }).toString();
  const payload = await fetchJson(endpoint.toString());
  const item = payload.items?.[0];
  if (!item) throw new Error('API에서 채널을 찾지 못했습니다.');
  return {
    title: item.snippet?.title || '',
    avatarUrl: bestThumbnail(item.snippet?.thumbnails),
    subscriberCount: item.statistics?.hiddenSubscriberCount
      ? null
      : numberOrNull(item.statistics?.subscriberCount),
    subscriberText: item.statistics?.hiddenSubscriberCount
      ? '비공개'
      : formatCompactNumber(item.statistics?.subscriberCount)
  };
}

function parseInitialData(html) {
  if (!html) return null;
  const markers = [
    'var ytInitialData =',
    'window["ytInitialData"] =',
    "window['ytInitialData'] =",
    'ytInitialData ='
  ];
  for (const marker of markers) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex === -1) continue;
    const objectStart = html.indexOf('{', markerIndex + marker.length);
    const json = extractBalancedObject(html, objectStart);
    if (!json) continue;
    try {
      return JSON.parse(json);
    } catch {
      // Try the next assignment form.
    }
  }
  return null;
}

function extractBalancedObject(source, startIndex) {
  if (startIndex < 0 || source[startIndex] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex, index + 1);
    }
  }
  return null;
}

function parseVideosFromInitialData(data) {
  const videos = [];
  walkObject(data, (key, renderer) => {
    if (!['videoRenderer', 'gridVideoRenderer', 'compactVideoRenderer'].includes(key)) return;
    if (!renderer?.videoId) return;
    const labels = [
      ...collectBadgeLabels(renderer.badges),
      ...collectOverlayLabels(renderer.thumbnailOverlays)
    ];
    const labelText = labels.join(' ').toUpperCase();
    const overlayStyles = (renderer.thumbnailOverlays || [])
      .map((overlay) => overlay?.thumbnailOverlayTimeStatusRenderer?.style)
      .filter(Boolean);
    const scheduledSeconds = renderer.upcomingEventData?.startTime;
    const scheduledTimestamp = scheduledSeconds
      ? Number(scheduledSeconds) * 1000
      : Number.NaN;
    const scheduledStart = Number.isFinite(scheduledTimestamp)
      ? new Date(scheduledTimestamp).toISOString()
      : null;
    const isLive = overlayStyles.includes('LIVE')
      || /\bLIVE NOW\b|실시간|생방송/.test(labelText);
    const hasExplicitUpcomingBadge = (
      overlayStyles.includes('UPCOMING')
      || /UPCOMING|예정|공개 예정|PREMIERE/.test(labelText)
    );
    const isUpcoming = !isLive && (
      scheduledStart
        ? scheduledTimestamp > Date.now()
        : hasExplicitUpcomingBadge
    );

    videos.push({
      id: renderer.videoId,
      title: textFrom(renderer.title) || '제목 없음',
      url: `${YOUTUBE_ORIGIN}/watch?v=${renderer.videoId}`,
      thumbnailUrl: bestThumbnail(renderer.thumbnail?.thumbnails),
      publishedText: textFrom(renderer.publishedTimeText),
      scheduledStart,
      isLive,
      isUpcoming
    });
  });
  return uniqueById(videos);
}

function parsePostsFromInitialData(data) {
  const posts = [];
  walkObject(data, (key, renderer) => {
    if (key !== 'backstagePostRenderer' || !renderer) return;
    const postId = renderer.postId || renderer.entityKey;
    if (!postId) return;
    const endpointUrl = renderer.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url;
    posts.push({
      id: postId,
      text: textFrom(renderer.contentText) || textFrom(renderer.content) || '새 게시물',
      publishedText: textFrom(renderer.publishedTimeText),
      url: endpointUrl
        ? new URL(endpointUrl, YOUTUBE_ORIGIN).toString()
        : `${YOUTUBE_ORIGIN}/post/${encodeURIComponent(postId)}`,
      imageUrl: bestThumbnail(renderer.backstageAttachment?.backstageImageRenderer?.image?.thumbnails)
    });
  });
  return uniqueById(posts);
}

function parseChannelMetadata(data, html = '') {
  let metadataRenderer = null;
  let subscriberNode = null;
  let subscriberFallback = '';
  if (data) {
    walkObject(data, (key, value) => {
      if (!metadataRenderer && key === 'channelMetadataRenderer') metadataRenderer = value;
      if (!subscriberNode && /subscriberCountText$/i.test(key)) subscriberNode = value;
      if (!subscriberFallback && typeof value === 'string') {
        const normalized = value.replace(/[\u2066-\u2069]/g, '').trim();
        if (/^구독자\s*[\d.,]+\s*(?:천|만|억)?명?$/.test(normalized)
          || /^[\d.,]+\s*[KMB]?\s+subscribers?$/i.test(normalized)) {
          subscriberFallback = normalized;
        }
      }
    });
  }

  const title = metadataRenderer?.title
    || matchMetaContent(html, 'og:title')
    || 'YouTube 채널';
  const avatarUrl = bestThumbnail(metadataRenderer?.avatar?.thumbnails)
    || matchMetaContent(html, 'og:image')
    || '';
  const subscriberText = textFrom(subscriberNode) || subscriberFallback;

  return {
    title: decodeHtml(title),
    avatarUrl,
    subscriberText: subscriberText || '확인 중',
    subscriberCount: parseLocalizedCount(subscriberText),
    source: 'page'
  };
}

function parsePlayerBroadcast(html, finalUrl = '') {
  if (!html) return null;
  const markers = ['var ytInitialPlayerResponse =', 'ytInitialPlayerResponse ='];
  let player = null;
  for (const marker of markers) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex === -1) continue;
    const json = extractBalancedObject(html, html.indexOf('{', markerIndex + marker.length));
    if (!json) continue;
    try {
      player = JSON.parse(json);
      break;
    } catch {
      // Ignore malformed embedded data.
    }
  }
  if (!player) return null;

  const videoId = player.videoDetails?.videoId
    || safeVideoIdFromUrl(finalUrl)
    || null;
  if (!videoId) return null;
  const liveDetails = player.microformat?.playerMicroformatRenderer?.liveBroadcastDetails || {};
  const scheduledStart = liveDetails.startTimestamp || null;
  const scheduledTime = scheduledStart
    ? new Date(scheduledStart).getTime()
    : Number.NaN;
  const isLive = liveDetails.isLiveNow === true || player.videoDetails?.isLive === true;
  const isUpcoming = !isLive
    && Boolean(player.videoDetails?.isLiveContent)
    && Number.isFinite(scheduledTime)
    && scheduledTime > Date.now();
  if (!isLive && !isUpcoming) return null;

  return {
    id: videoId,
    title: player.videoDetails?.title || 'YouTube 라이브',
    url: `${YOUTUBE_ORIGIN}/watch?v=${videoId}`,
    thumbnailUrl: bestThumbnail(player.videoDetails?.thumbnail?.thumbnails),
    scheduledStart,
    isLive,
    isUpcoming
  };
}

function parseVideoFeed(xml) {
  if (!xml) return [];
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  return entries.map((entry) => {
    const id = matchXml(entry, 'yt:videoId');
    if (!id) return null;
    return {
      id,
      title: decodeHtml(matchXml(entry, 'title') || '제목 없음'),
      url: `${YOUTUBE_ORIGIN}/watch?v=${id}`,
      publishedAt: matchXml(entry, 'published') || null,
      updatedAt: matchXml(entry, 'updated') || null,
      thumbnailUrl: matchXmlAttribute(entry, 'media:thumbnail', 'url'),
      isLive: false,
      isUpcoming: false
    };
  }).filter(Boolean);
}

function parseLocalizedCount(text) {
  if (!text) return null;
  const normalized = String(text).replace(/,/g, '').trim();
  const match = normalized.match(/([\d.]+)\s*(억|만|천|[KMB])?/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] || '').toUpperCase();
  const multiplier = {
    '천': 1_000,
    '만': 10_000,
    '억': 100_000_000,
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000
  }[unit] || 1;
  return Math.round(value * multiplier);
}

function matchMetaContent(html, property) {
  if (!html) return '';
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escaped}["']`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return '';
}

function walkObject(value, visitor, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walkObject(item, visitor, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    visitor(key, child, value);
    walkObject(child, visitor, seen);
  }
}

function textFrom(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.simpleText === 'string') return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map((run) => run.text || '').join('');
  if (typeof value.content === 'string') return value.content;
  return '';
}

function collectBadgeLabels(badges = []) {
  return badges.flatMap((badge) => {
    const renderer = badge?.metadataBadgeRenderer || badge?.liveBroadcastingBadgeRenderer;
    return [
      renderer?.label,
      renderer?.tooltip,
      renderer?.style
    ].filter(Boolean);
  });
}

function collectOverlayLabels(overlays = []) {
  return overlays.flatMap((overlay) => {
    const renderer = overlay?.thumbnailOverlayTimeStatusRenderer;
    return [textFrom(renderer?.text), renderer?.style].filter(Boolean);
  });
}

function bestThumbnail(thumbnails) {
  if (!thumbnails) return '';
  if (!Array.isArray(thumbnails)) {
    return bestThumbnail(Object.values(thumbnails));
  }
  return thumbnails
    .filter((thumbnail) => thumbnail?.url)
    .sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || '';
}

function matchXml(source, tag) {
  const escaped = tag.replace(':', '\\:');
  const match = source.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? stripCdata(match[1]).trim() : '';
}

function matchXmlAttribute(source, tag, attribute) {
  const escapedTag = tag.replace(':', '\\:');
  const match = source.match(new RegExp(`<${escapedTag}[^>]+${attribute}=["']([^"']+)["']`, 'i'));
  return match ? decodeHtml(match[1]) : '';
}

function stripCdata(value) {
  return decodeHtml(String(value).replace(/^<!\[CDATA\[|\]\]>$/g, ''));
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function safeVideoIdFromUrl(value) {
  try {
    const url = new URL(value);
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return null;
    const id = url.searchParams.get('v');
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch {
    return null;
  }
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function mergeBroadcast(primary, secondary) {
  if (!secondary || primary.id !== secondary.id) return primary;
  return {
    ...secondary,
    ...primary,
    thumbnailUrl: primary.thumbnailUrl || secondary.thumbnailUrl,
    scheduledStart: primary.scheduledStart || secondary.scheduledStart
  };
}

function dateValue(value) {
  const timestamp = value ? new Date(value).getTime() : Number.MAX_SAFE_INTEGER;
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function formatCompactNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '확인 중';
  return new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 2 }).format(numeric);
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatRequestWarning(label, error) {
  const suffix = error?.status ? ` (HTTP ${error.status})` : '';
  return `${label} 확인 실패${suffix}`;
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new YouTubeRequestError(`YouTube 요청 실패: ${response.status}`, response.status);
  }
  const body = await response.text();
  return options.includeFinalUrl ? { body, url: response.url } : body;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload.error?.message || '';
    } catch {
      // The status code is enough when the response is not JSON.
    }
    throw new YouTubeRequestError(detail || `API 요청 실패: ${response.status}`, response.status);
  }
  return response.json();
}

module.exports = {
  YouTubeRequestError,
  decodeHtml,
  extractBalancedObject,
  extractHandle,
  fetchChannelSnapshot,
  findChannelId,
  normalizeChannelId,
  parseChannelMetadata,
  parseInitialData,
  parseLocalizedCount,
  parsePlayerBroadcast,
  parsePostsFromInitialData,
  parseVideoFeed,
  parseVideosFromInitialData,
  resolveChannelInput,
  safeVideoIdFromUrl
};
