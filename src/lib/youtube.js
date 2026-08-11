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
    videos: fetchText(`${channelUrl}/videos`),
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
  const streamVideos = streamsData ? parseVideosFromInitialData(streamsData) : [];
  if (settled.streams.status === 'rejected') warnings.push(formatRequestWarning('방송 목록', settled.streams.reason));

  const videosHtml = settled.videos.status === 'fulfilled' ? settled.videos.value : '';
  const videosData = videosHtml ? parseInitialData(videosHtml) : null;
  const uploadedVideos = videosData ? parseVideosFromInitialData(videosData) : [];
  if (settled.videos.status === 'rejected') warnings.push(formatRequestWarning('동영상 목록', settled.videos.reason));

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

  const metadataData = streamsData || videosData;
  const metadataHtml = streamsHtml || videosHtml;
  const scrapedMetadata = parseChannelMetadata(metadataData, metadataHtml);
  let metadata = scrapedMetadata;
  if (settled.official?.status === 'fulfilled') {
    metadata = { ...scrapedMetadata, ...settled.official.value, source: 'api' };
  } else if (settled.official?.status === 'rejected') {
    warnings.push(formatRequestWarning('공식 채널 통계', settled.official.reason));
  }

  const listedVideos = uniqueById([...streamVideos, ...uploadedVideos]);
  const pageLive = listedVideos.find((video) => video.isLive) || null;
  const live = selectLiveBroadcast(
    playerBroadcast,
    pageLive,
    settled.live.status === 'fulfilled'
  );

  const upcomingCandidates = listedVideos
    .filter((video) => video.isUpcoming && (!live || video.id !== live.id))
    .sort((a, b) => dateValue(a.scheduledStart) - dateValue(b.scheduledStart));
  if (playerBroadcast?.isUpcoming && (!live || playerBroadcast.id !== live.id)) {
    upcomingCandidates.push(playerBroadcast);
    upcomingCandidates.sort((a, b) => dateValue(a.scheduledStart) - dateValue(b.scheduledStart));
  }

  let recentVideos = selectRecentVideos(uploadedVideos, feed, streamVideos);
  let videoStats = [];
  if (options.includeVideoStats && recentVideos.length) {
    try {
      const result = await fetchVideoStatistics(
        recentVideos.slice(0, 8).map((video) => video.id),
        options.apiKey
      );
      videoStats = result.items;
      if (result.warning) warnings.push(result.warning);
      const statsById = new Map(videoStats.map((item) => [item.id, item]));
      recentVideos = recentVideos.map((video) => ({
        ...video,
        ...(statsById.get(video.id) || {}),
        title: statsById.get(video.id)?.title || video.title,
        thumbnailUrl: statsById.get(video.id)?.thumbnailUrl || video.thumbnailUrl,
        publishedAt: statsById.get(video.id)?.publishedAt || video.publishedAt
      }));
    } catch (error) {
      warnings.push(formatRequestWarning('영상 조회수', error));
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    metadata,
    live: live || null,
    upcoming: uniqueById(upcomingCandidates).slice(0, 5),
    latestVideo: recentVideos[0] || null,
    latestPost: posts[0] || null,
    recentVideos,
    videoStats,
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
    if (key === 'lockupViewModel') {
      const video = parseLockupVideo(renderer);
      if (video) videos.push(video);
      return;
    }
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
    const isUpcoming = !isLive
      && Boolean(scheduledStart)
      && scheduledTimestamp > Date.now();

    videos.push({
      id: renderer.videoId,
      title: textFrom(renderer.title) || '제목 없음',
      url: `${YOUTUBE_ORIGIN}/watch?v=${renderer.videoId}`,
      thumbnailUrl: bestThumbnail(renderer.thumbnail?.thumbnails),
      publishedText: textFrom(renderer.publishedTimeText),
      viewCount: parseLocalizedCount(textFrom(renderer.viewCountText)),
      scheduledStart,
      isLive,
      isUpcoming
    });
  });
  return uniqueById(videos);
}

function parseLockupVideo(lockup) {
  if (!lockup || lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
  const videoId = lockup.contentId
    || lockup.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId;
  if (!/^[\w-]{11}$/.test(videoId || '')) return null;

  const metadata = lockup.metadata?.lockupMetadataViewModel;
  const metadataParts = (metadata?.metadata?.contentMetadataViewModel?.metadataRows || [])
    .flatMap((row) => row?.metadataParts || []);
  const metadataTexts = metadataParts.map((part) => textFrom(part?.text)).filter(Boolean);
  const viewText = metadataTexts.find((text) => /조회수|views?/i.test(text)) || '';
  const publishedText = metadataTexts.find((text) => text !== viewText) || '';
  const labels = [];
  const styles = [];
  walkObject(lockup.contentImage, (key, value) => {
    if (key !== 'thumbnailBadgeViewModel' || !value) return;
    labels.push(value.text, value.rendererContext?.accessibilityContext?.label);
    styles.push(value.badgeStyle);
  });
  const labelText = labels.filter(Boolean).join(' ').toUpperCase();
  const styleText = styles.filter(Boolean).join(' ').toUpperCase();
  const endpoint = lockup.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint;
  const scheduledSeconds = endpoint?.startTimeSeconds;
  const scheduledTimestamp = scheduledSeconds ? Number(scheduledSeconds) * 1000 : Number.NaN;
  const scheduledStart = Number.isFinite(scheduledTimestamp)
    ? new Date(scheduledTimestamp).toISOString()
    : null;
  const isLive = /(?:^|_)LIVE(?:_|$)/.test(styleText)
    || /\bLIVE NOW\b|실시간|생방송/.test(labelText);
  const isUpcoming = !isLive
    && Boolean(scheduledStart)
    && scheduledTimestamp > Date.now();

  return {
    id: videoId,
    title: textFrom(metadata?.title) || '제목 없음',
    url: `${YOUTUBE_ORIGIN}/watch?v=${videoId}`,
    thumbnailUrl: bestThumbnail(lockup.contentImage?.thumbnailViewModel?.image?.sources),
    publishedText,
    viewCount: parseLocalizedCount(viewText),
    scheduledStart,
    isLive,
    isUpcoming
  };
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

function parsePlayerResponse(html) {
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
  return player;
}

function parsePlayerBroadcast(html, finalUrl = '') {
  const player = parsePlayerResponse(html);
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

function parseVideoStatistics(html, finalUrl = '', source = 'page') {
  const player = parsePlayerResponse(html);
  if (!player || player.playabilityStatus?.status !== 'OK') return null;
  const videoId = player.videoDetails?.videoId || safeVideoIdFromUrl(finalUrl);
  if (!/^[\w-]{11}$/.test(videoId || '')) return null;
  const microformat = player.microformat?.playerMicroformatRenderer || {};
  return {
    id: videoId,
    title: player.videoDetails?.title || textFrom(microformat.title) || '제목 없음',
    url: `${YOUTUBE_ORIGIN}/watch?v=${videoId}`,
    thumbnailUrl: bestThumbnail(player.videoDetails?.thumbnail?.thumbnails)
      || bestThumbnail(microformat.thumbnail?.thumbnails),
    publishedAt: microformat.publishDate || microformat.uploadDate || null,
    viewCount: numberOrNull(player.videoDetails?.viewCount ?? microformat.viewCount),
    source
  };
}

async function fetchVideoStatistics(videoIds, apiKey = '') {
  const ids = [...new Set((videoIds || []).filter((id) => /^[\w-]{11}$/.test(id)))].slice(0, 8);
  if (!ids.length) return { items: [], warning: null };
  let apiError = null;
  if (apiKey) {
    try {
      const officialItems = await fetchOfficialVideos(ids, apiKey);
      const officialIds = new Set(officialItems.map((item) => item.id));
      const missingIds = ids.filter((id) => !officialIds.has(id));
      if (!missingIds.length) return { items: officialItems, warning: null };
      const fallbackItems = await fetchPublicVideoStatistics(missingIds);
      return { items: [...officialItems, ...fallbackItems], warning: null };
    } catch (error) {
      apiError = error;
    }
  }
  const items = await fetchPublicVideoStatistics(ids);
  return {
    items,
    warning: apiError ? formatRequestWarning('공식 영상 통계 · 공개 페이지로 대체', apiError) : null
  };
}

async function fetchOfficialVideos(videoIds, apiKey) {
  const endpoint = new URL('https://www.googleapis.com/youtube/v3/videos');
  endpoint.search = new URLSearchParams({
    part: 'snippet,statistics,status',
    id: videoIds.join(','),
    key: apiKey
  }).toString();
  const payload = await fetchJson(endpoint.toString());
  return (payload.items || []).map((item) => ({
    id: item.id,
    title: item.snippet?.title || '제목 없음',
    url: `${YOUTUBE_ORIGIN}/watch?v=${item.id}`,
    thumbnailUrl: bestThumbnail(item.snippet?.thumbnails),
    publishedAt: item.snippet?.publishedAt || null,
    viewCount: numberOrNull(item.statistics?.viewCount),
    source: 'api'
  })).filter((item) => /^[\w-]{11}$/.test(item.id || '') && Number.isFinite(item.viewCount));
}

async function fetchPublicVideoStatistics(videoIds) {
  const results = await Promise.allSettled(videoIds.map(async (videoId) => {
    const response = await fetchText(`${YOUTUBE_ORIGIN}/watch?v=${videoId}`, { includeFinalUrl: true });
    return parseVideoStatistics(response.body, response.url, 'page');
  }));
  const items = results
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result) => result.value)
    .filter((item) => Number.isFinite(item.viewCount));
  if (!items.length && results.some((result) => result.status === 'rejected')) {
    throw results.find((result) => result.status === 'rejected').reason;
  }
  return items;
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

function selectRecentVideos(uploadedVideos, feedVideos, streamVideos, limit = 8) {
  return uniqueById([
    ...(uploadedVideos || []).filter((video) => !video.isLive && !video.isUpcoming),
    ...(feedVideos || []).filter((video) => !video.isLive && !video.isUpcoming),
    ...(streamVideos || []).filter((video) => !video.isLive && !video.isUpcoming)
  ]).slice(0, limit);
}

function selectLiveBroadcast(playerBroadcast, pageLive, livePageAvailable = true) {
  if (playerBroadcast?.isLive) return mergeBroadcast(playerBroadcast, pageLive);
  if (!livePageAvailable && pageLive?.isLive) return pageLive;
  return null;
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
  fetchVideoStatistics,
  findChannelId,
  normalizeChannelId,
  parseChannelMetadata,
  parseInitialData,
  parseLocalizedCount,
  parsePlayerBroadcast,
  parseVideoStatistics,
  parsePostsFromInitialData,
  parseVideoFeed,
  parseVideosFromInitialData,
  resolveChannelInput,
  safeVideoIdFromUrl,
  selectLiveBroadcast,
  selectRecentVideos
};
