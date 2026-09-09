const express = require('express');
const axios = require('axios');
const config = require('./config');
const bot = require('./bot');

const app = express();
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
const server = app.listen(config.port, () => console.log(`Health server listening on ${config.port}`));

const keepAlive = setInterval(() => axios.get(config.keepAliveUrl, { timeout: 8000 }).catch(() => {}), 600000);
keepAlive.unref();

let botStarting = false;
let botReady = false;
const startBot = async () => {
  if (botStarting || botReady) return;
  botStarting = true;
  try {
    await bot.start();
    botReady = true;
    console.log('Telegram bot started');
  } catch (error) {
    console.error(`Telegram startup failed; retrying in 30s: ${error.description || error.message}`);
    setTimeout(startBot, 30000).unref();
  } finally {
    botStarting = false;
  }
};
startBot();
const shutdown = async (signal) => { console.log(`${signal}: shutting down`); clearInterval(keepAlive); await bot.stop(); server.close(() => process.exit(0)); };
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
