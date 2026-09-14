const express = require('express');
const http = require('http');
const app = express();
const PORT = Number(process.env.PORT || 3000);
let server = null;
global.START_TIME = global.START_TIME || null;
global.LAST_ACTIVITY = global.LAST_ACTIVITY || null;
app.use(express.json());
app.use((req, _res, next) => { global.LAST_ACTIVITY = new Date().toISOString(); next(); });
app.get('/health', (_req, res) => res.status(200).json({ status: 'alive', ts: Date.now(), uptime: process.uptime(), pid: process.pid, lastActivity: global.LAST_ACTIVITY }));
app.get('/', (_req, res) => res.status(200).send('Bot is Active'));
app.get('/whoami', (_req, res) => { let started = false; try { started = Boolean(require('./bot').botStarted); } catch (_) {} res.json({ pid: process.pid, startTime: global.START_TIME, botStarted: started }); });
app.get('/watcher-status', (_req, res) => {
  try {
    const bot = require('./bot'); const w = bot.watcher;
    if (!w) return res.status(200).json({ running: false, error: 'no-watcher-instance', uptime: process.uptime() });
    res.status(200).json({ running: Boolean(w.running), source: w.source || 'DexPaprika', checked: Number(w.checkedCount || 0), seen: Number(w.seen?.size || 0), lastPollAt: w.lastPollAt || null, lastPollDurationMs: w.lastPollDurationMs || null, lastError: w.lastError || null, lastMint: w.lastCandidate?.mint || null, lastSymbol: w.lastCandidate?.symbol || null, rejectStats: w.rejectStats || {}, pollCount: Number(w.pollCount || 0), startedAt: w.startedAt || null, uptime: process.uptime(), env: { hasDexPaprika: true, hasGoPlus: Boolean(process.env.GOPLUS_API_KEY), hasSolanaTracker: Boolean(process.env.SOLANA_TRACKER_API_KEY) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/ping', (_req, res) => res.status(200).send('pong'));
app.get('/cron-ping', (_req, res) => res.status(200).json({ status: 'awake', ts: Date.now(), uptime: process.uptime() }));
function startHealthServer() { if (server) return server; global.START_TIME = new Date().toISOString(); server = app.listen(PORT, () => console.log(`Health server listening on ${PORT}`)); return server; }
module.exports = { app, startHealthServer };
