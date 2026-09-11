const express = require('express');
const https = require('https');

const app = express();
const PORT = Number(process.env.PORT || 3000);
let server = null;
let pingTimer = null;

app.get('/health', (_req, res) => res.status(200).json({ status: 'alive', ts: Date.now() }));
app.get('/', (_req, res) => res.status(200).send('Bot is running'));
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
    if (externalUrl && !pingTimer) {
      const pingUrl = `${externalUrl.replace(/\/$/, '')}/health`;
      pingTimer = setInterval(() => {
        https.get(pingUrl, (response) => {
          response.resume();
          console.log(`Self-ping: ${response.statusCode}`);
        }).on('error', (error) => console.error(`Ping error: ${error.message}`));
      }, 14 * 60 * 1000);
    }
  });
  return server;
}

module.exports = { startHealthServer };
