const express = require('express');
const https = require('https');
const http = require('http');

const app = express();
const PORT = Number(process.env.PORT || 3000);
let server = null;
let pingTimer = null;

global.START_TIME = global.START_TIME || null;
global.LAST_ACTIVITY = global.LAST_ACTIVITY || null;

// تحديث آخر نشاط قبل معالجة كل طلب HTTP.
app.use((req, _res, next) => {
  global.LAST_ACTIVITY = new Date().toISOString();
  next();
});

app.get('/health', (_req, res) => res.status(200).json({
  status: 'alive',
  ts: Date.now(),
  uptime: process.uptime(),
  pid: process.pid,
}));

app.get('/', (_req, res) => res.status(200).send('Bot is running'));

app.get('/ping', (_req, res) => {
  console.log(`[ping] Local ping at ${new Date().toISOString()}`);
  res.status(200).send('pong');
});

app.get('/cron-ping', (req, res) => {
  const ua = req.headers['user-agent'] || 'unknown';
  const ip = req.ip || req.connection.remoteAddress;
  console.log(`[cron] External ping received from ${ip} | UA: ${String(ua).slice(0, 60)} at ${new Date().toISOString()}`);
  res.status(200).json({
    status: 'awake',
    ts: Date.now(),
    uptime: process.uptime(),
    serviceStart: global.START_TIME || null,
    lastActivity: global.LAST_ACTIVITY || null,
  });
});

app.get('/helius-status', (_req, res) => {
  try {
    const bot = require('./bot');
    const w = bot.watcher;
    res.json({
      helius: {
        streamMode: w?.streamMode || false,
        wsReadyState: w?.helius?.ws?.readyState ?? null,
        lastEventAt: w?.helius?.lastEventAt || null,
        lastError: w?.helius?.lastError || null,
        subscriptionId: w?.helius?.subscriptionId || null,
      },
      watcher: {
        running: w?.running || false,
        seenCount: w?.seen?.size || 0,
        watchlistSize: w?.watchlist?.size || 0,
        lastPollAt: w?.lastPollAt || null,
      },
      env: {
        hasApiKey: !!process.env.HELIUS_API_KEY,
        hasRpcUrl: !!process.env.HELIUS_RPC_URL,
        hasWsUrl: !!process.env.HELIUS_WS_URL,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function startHealthServer() {
  if (server) return server;

  global.START_TIME = new Date().toISOString();
  server = app.listen(PORT, () => {
    console.log(`Health server listening on ${PORT}`);
    console.log(`[keep-alive] Start time: ${global.START_TIME}`);

    const externalUrl = process.env.RENDER_EXTERNAL_URL;
    const internalInterval = 4 * 60 * 1000;

    if (externalUrl) {
      const baseUrl = externalUrl.replace(/\/$/, '');
      const targets = [
        `${baseUrl}/ping`,
        `${baseUrl}/cron-ping`,
        `${baseUrl}/health`,
      ];
      const doPing = async () => {
        for (const url of targets) {
          try {
            const startedAt = Date.now();
            await new Promise((resolve, reject) => {
              const client = url.startsWith('https') ? https : http;
              const request = client.get(url, { timeout: 10000 }, (response) => {
                response.resume();
                const ms = Date.now() - startedAt;
                console.log(`[keep-alive] ✅ ${url} → ${response.statusCode} (${ms}ms)`);
                resolve();
              });
              request.on('error', reject);
              request.on('timeout', () => {
                request.destroy();
                reject(new Error('timeout'));
              });
            });
          } catch (error) {
            console.error(`[keep-alive] ❌ ${url}: ${error.message}`);
          }
        }
      };

      setTimeout(doPing, 5000).unref();
      pingTimer = setInterval(doPing, internalInterval);
      console.log(`[keep-alive] Self-ping enabled every 4 min → ${targets.length} targets`);
    } else {
      console.warn('[keep-alive] ⚠️ RENDER_EXTERNAL_URL not set');
    }
  });

  return server;
}

module.exports = { startHealthServer };
