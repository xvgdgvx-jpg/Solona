const express = require('express');
const axios = require('axios');
const config = require('./config');
const bot = require('./bot');

const app = express();
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
const server = app.listen(config.port, () => console.log(`Health server listening on ${config.port}`));

const keepAlive = setInterval(() => axios.get(config.keepAliveUrl, { timeout: 8000 }).catch(() => {}), 600000);
keepAlive.unref();

bot.start().then(() => console.log('Telegram bot started')).catch((error) => { console.error('Bot startup failed:', error); process.exitCode = 1; });
const shutdown = async (signal) => { console.log(`${signal}: shutting down`); clearInterval(keepAlive); await bot.stop(); server.close(() => process.exit(0)); };
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
