const express = require('express');
const https = require('https');

const app = express();
const PORT = Number(process.env.PORT || 3000);
let server = null;
let pingTimer = null;

app.get('/health', (_req, res) => res.status(200).json({ status: 'alive', ts: Date.now() }));
app.get('/', (_req, res) => res.status(200).send('Bot is running'));

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
