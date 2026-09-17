'use strict';

const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { Collector, RedisStore, MINUTE } = require('./collector');

function createServer({ store, collector, readToken }) {
  if (!readToken || readToken.length < 32) throw new Error('A strong CLOUD_READ_TOKEN is required');
  return http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return reply(400, { error: 'Invalid URL' }); }
    if (req.method === 'GET' && url.pathname === '/healthz') return reply(200, { ok: true });
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${readToken}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: 'Unauthorized' });
    if (req.method !== 'GET' || url.pathname !== '/v1/sync') return reply(404, { error: 'Not found' });
    const after = Number(url.searchParams.get('after') || 0);
    if (!Number.isSafeInteger(after) || after < 0 || after > Date.now()) return reply(400, { error: 'Invalid cursor' });
    try {
      reply(200, { ...await store.read(after), status: { lastSuccessAt: collector.lastSuccessAt, error: collector.lastError } });
    } catch {
      reply(503, { error: 'Storage unavailable' });
    }
  });
}

if (require.main === module) {
  const store = new RedisStore(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN);
  const collector = new Collector({ store, channelIds: (process.env.CHANNEL_IDS || '').split(',').filter(Boolean), apiKey: process.env.YOUTUBE_API_KEY });
  const server = createServer({ store, collector, readToken: process.env.CLOUD_READ_TOKEN });
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
  const tick = async () => {
    await collector.collect();
    console.log(JSON.stringify({ at: collector.lastSuccessAt, error: collector.lastError }));
  };
  void tick();
  const timer = setInterval(tick, MINUTE);
  process.on('SIGTERM', () => { clearInterval(timer); server.close(); });
}

module.exports = { createServer };
