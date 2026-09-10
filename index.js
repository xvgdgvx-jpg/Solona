const express = require('express');
const axios = require('axios');
const config = require('./config');
const bot = require('./bot');

const app = express();
let botStarting = false;
let botReady = false;
let lastBotError = null;
let shuttingDown = false;
app.get('/health', (_req, res) => res.json({ status: botReady ? 'ok' : 'degraded', uptime: process.uptime(), telegram: botReady ? 'ready' : 'starting-or-retrying', watcher: bot.watcher?.status?.() || null, lastBotError }));
const server = app.listen(config.port, () => console.log(`Health server listening on ${config.port}`));

const keepAlive = setInterval(() => axios.get(config.keepAliveUrl, { timeout: 8000 }).catch(() => {}), 600000);
keepAlive.unref();
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
    await bot.start();
    botReady = true;
    retryDelayMs = 5000;
    lastBotError = null;
    console.log('Telegram bot started');
    bot.startWatcher();
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
