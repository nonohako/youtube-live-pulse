'use strict';

const { fetchChannelSnapshot, parsePlayerBroadcast } = require('../src/lib/youtube');
const { TARGET_CHANNEL_ID } = require('../src/lib/defaults');

async function main() {
  const videoArgumentIndex = process.argv.indexOf('--video');
  if (videoArgumentIndex !== -1) {
    await inspectVideo(process.argv[videoArgumentIndex + 1]);
    return;
  }
  if (process.argv.includes('--inspect-subscribers')) {
    await inspectSubscriberMarkup();
    return;
  }
  const result = await fetchChannelSnapshot({ id: TARGET_CHANNEL_ID });
  const summary = {
    title: result.metadata.title,
    subscribers: result.metadata.subscriberText,
    live: result.live && { id: result.live.id, title: result.live.title },
    upcoming: result.upcoming.map(({ id, title, scheduledStart }) => ({
      id,
      title,
      scheduledStart
    })),
    latestVideo: result.latestVideo && {
      id: result.latestVideo.id,
      title: result.latestVideo.title
    },
    latestPost: result.latestPost && {
      id: result.latestPost.id,
      text: result.latestPost.text.slice(0, 80)
    },
    warnings: result.warnings
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (result.warnings.length >= 4) process.exitCode = 1;
}

async function inspectVideo(videoId) {
  if (!/^[\w-]{11}$/.test(videoId || '')) {
    throw new Error('--video 뒤에 11자리 YouTube 영상 ID를 입력하세요.');
  }
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'accept-language': 'ko-KR,ko;q=0.9,en;q=0.7',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36',
      cookie: 'SOCS=CAI'
    }
  });
  const html = await response.text();
  process.stdout.write(`${JSON.stringify({
    videoId,
    parsedBroadcast: parsePlayerBroadcast(html, response.url)
  }, null, 2)}\n`);
}

async function inspectSubscriberMarkup() {
  for (const suffix of ['', '/about', '/streams']) {
    const url = `https://www.youtube.com/channel/${TARGET_CHANNEL_ID}${suffix}`;
    const response = await fetch(url, {
      headers: {
        'accept-language': 'ko-KR,ko;q=0.9,en;q=0.7',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36',
        cookie: 'SOCS=CAI'
      }
    });
    const html = await response.text();
    const matches = [];
    for (const pattern of [
      /subscriberCountText.{0,240}/gi,
      /"subscriberCount".{0,180}/gi,
      /구독자.{0,120}/g,
      /[\d.]+\s*[KMB]\s+subscribers.{0,80}/gi
    ]) {
      matches.push(...(html.match(pattern) || []).slice(0, 3));
    }
    process.stdout.write(`${suffix || '/'} (${response.status})\n${matches.join('\n') || 'NO MATCH'}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
