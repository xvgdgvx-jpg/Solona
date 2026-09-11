const express = require('express');
const https = require('https');
const http = require('http');

const app = express();
const PORT = Number(process.env.PORT || 3000);
let server = null;
let pingTimer = null;
let externalPingTimer = null;

function pingExternal(url, label) {
  const client = url.startsWith('https') ? https : http;
  client.get(url, (response) => {
    response.resume();
    console.log(`[keep-alive] External ping ${label}: ${response.statusCode}`);
  }).on('error', (error) => {
    console.error(`[keep-alive] External ping ${label} failed: ${error.message}`);
  });
}

app.get('/health', (_req, res) => res.status(200).json({ status: 'alive', ts: Date.now(), uptime: process.uptime(), pid: process.pid }));
app.get('/', (_req, res) => res.status(200).send('Bot is running'));
app.get('/ping', (_req, res) => {
  console.log(`[ping] Local ping at ${new Date().toISOString()}`);
  res.status(200).send('pong');
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
  server = app.listen(PORT, () => {
    console.log(`Health server listening on ${PORT}`);
    const externalUrl = process.env.RENDER_EXTERNAL_URL;
    const pingInterval = 5 * 60 * 1000;
    if (externalUrl && !pingTimer) {
      const pingUrl = `${externalUrl.replace(/\/$/, '')}/ping`;
      const client = pingUrl.startsWith('https') ? https : http;
      console.log(`[keep-alive] Self-ping enabled: ${pingUrl} every 5 minutes`);
      const doPing = () => {
        const startTime = Date.now();
        client.get(pingUrl, (response) => {
          response.resume();
          const ms = Date.now() - startTime;
          console.log(`[keep-alive] ✅ Ping ${response.statusCode} (${ms}ms) at ${new Date().toISOString()}`);
        }).on('error', (error) => {
          console.error(`[keep-alive] ❌ Ping error: ${error.message}`);
        });
      };
      setTimeout(doPing, 10000).unref();
      pingTimer = setInterval(doPing, pingInterval);
    } else if (!externalUrl) {
      console.warn('[keep-alive] ⚠️ RENDER_EXTERNAL_URL not set — self-ping disabled');
    }
    if (!externalPingTimer) {
      externalPingTimer = setInterval(() => pingExternal('https://www.google.com', 'Google'), pingInterval);
    }
  });
  return server;
}

module.exports = { startHealthServer };
