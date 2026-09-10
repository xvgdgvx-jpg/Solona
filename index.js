const express = require('express');
const http = require('node:http');
const https = require('node:https');
const config = require('./config');
const bot = require('./bot');

const app = express();
const PORT = Number(process.env.PORT || config.port || 3000);
let botStarting = false;
let botReady = false;
let lastBotError = null;
let shuttingDown = false;
app.get('/health', (_req, res) => res.status(200).send('Bot is awake'));
const server = app.listen(PORT, () => console.log(`Health server listening on ${PORT}`));

const selfPingUrl = process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/health` : `http://localhost:${PORT}/health`;
function selfPing() {
  if (shuttingDown) return;
  try {
    const target = new URL(selfPingUrl);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.get(target, { timeout: 10000 }, (response) => {
      response.resume();
      console.log(`Self-ping status: ${response.statusCode} (${selfPingUrl})`);
    });
    request.on('error', (error) => console.error(`Self-ping error: ${error.message}`));
    request.on('timeout', () => request.destroy(new Error('Self-ping timeout')));
  } catch (error) {
    console.error(`Self-ping URL error: ${error.message}`);
  }
}
const keepAlive = setInterval(selfPing, 14 * 60 * 1000);
setTimeout(selfPing, 1000).unref();
const supervisor = setInterval(() => {
  if (!botReady || shuttingDown || !bot.watcher?.status) return;
  const status = bot.watcher.status();
  if (status.running) return;
  try { bot.startWatcher(); console.log('Supervisor checked the Pump.fun watcher'); } catch (error) { console.error(`Watcher supervisor error: ${error.message}`); }
}, 30000);
supervisor.unref();

let retryDelayMs = 5000;
let retryTimer = null;
const startBot = async () => {
  if (shuttingDown || botStarting || botReady) return;
  botStarting = true;
  try {
    const polling = bot.start();
    botReady = true;
    retryDelayMs = 5000;
    lastBotError = null;
    console.log('Telegram bot started');
    bot.startWatcher();
    polling.catch((error) => {
      if (shuttingDown) return;
      botReady = false;
      lastBotError = error.description || error.message;
      console.error(`Telegram polling stopped; retrying in ${retryDelayMs / 1000}s: ${lastBotError}`);
      retryTimer = setTimeout(startBot, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 60000);
    });
  } catch (error) {
    botReady = false;
    lastBotError = error.description || error.message;
    console.error(`Telegram startup failed; retrying in ${retryDelayMs / 1000}s: ${lastBotError}`);
    if (!shuttingDown) retryTimer = setTimeout(startBot, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, 60000);
  } finally {
    botStarting = false;
  }
};
startBot();
const shutdown = async (signal, exitCode = 0) => { if (shuttingDown) return; shuttingDown = true; console.log(`${signal}: shutting down`); clearInterval(keepAlive); clearInterval(supervisor); if (retryTimer) clearTimeout(retryTimer); try { await bot.stop(); } catch (error) { console.error(`Telegram stop error: ${error.message}`); } server.close(() => process.exit(exitCode)); setTimeout(() => process.exit(exitCode), 5000).unref(); };
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => { console.error(`Unhandled promise rejection: ${reason?.stack || reason}`); });
process.on('uncaughtException', (error) => { console.error(`Uncaught exception: ${error.stack || error.message}`); shutdown('UNCAUGHT_EXCEPTION', 1); });
