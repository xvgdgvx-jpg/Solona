const express = require('express');
const app = express();
let botStarted = false;
const PORT = Number(process.env.PORT || 3000);
let server = null;
global.START_TIME = global.START_TIME || null;
global.LAST_ACTIVITY = global.LAST_ACTIVITY || null;
app.use(express.json());
app.use((req, _res, next) => { global.LAST_ACTIVITY = new Date().toISOString(); next(); });
app.get('/health', (_req, res) => res.status(200).json({ status: 'alive', ts: Date.now(), uptime: process.uptime(), pid: process.pid, lastActivity: global.LAST_ACTIVITY }));
app.get('/', (_req, res) => res.status(200).send('Bot is Active'));
app.get('/whoami', (_req, res) => res.json({ pid: process.pid, startTime: global.START_TIME, botStarted }));
app.get('/watcher-status', (_req, res) => {
  try {
    const bot = require('./bot'); const w = bot.watcher;
    if (!w) return res.status(200).json({ running: false, error: 'no-watcher-instance', uptime: process.uptime() });
    res.status(200).json({ running: Boolean(w.running), source: w.source || 'DexPaprika', checked: Number(w.checkedCount || 0), seen: Number(w.seen?.size || 0), lastPollAt: w.lastPollAt || null, lastPollDurationMs: w.lastPollDurationMs || null, lastRequestDurationMs: w.lastRequestDurationMs || null, lastError: w.lastError || null, passCount: Number(w.passCount || 0), rejectCount: Number(w.rejectCount || 0), rejectByStage: w.rejectByStage || {}, lastRpcError: w.lastRpcError || null, uniqueMintsLastPoll: Number(w.uniqueMintsLastPoll || 0), activeFilters: { dex: w.settings?.dex || {}, onchain: w.settings?.onchain || {}, goplus: w.settings?.goplus || {}, tracker: w.settings?.tracker || {}, risk: w.settings?.risk || {} }, lastSeenAt: w.lastSeenAt || null, nextCursor: w.nextCursor ? 'set' : null, cursorPolls: Number(w.cursorPolls || 0), onChainCacheSize: Number(w.onChainCache?.size || 0), lastMint: w.lastCandidate?.mint || null, lastSymbol: w.lastCandidate?.symbol || null, rejectStats: w.rejectStats || {}, pollCount: Number(w.pollCount || 0), startedAt: w.startedAt || null, uptime: process.uptime(), env: { hasDexPaprika: true, hasGoPlus: Boolean(process.env.GOPLUS_API_KEY), hasSolanaTracker: Boolean(process.env.SOLANA_TRACKER_API_KEY) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/monitor-status', (_req, res) => {
  try {
    const bot = require('./bot');
    const config = require('./config');
    const { getPositions } = require('./services/paper');
    const positions = getPositions(config.adminId, config.encryptionKey).filter((p) => p.status === 'open');
    res.json({ monitorRunning: Boolean(bot.getMonitorTimer?.()), busy: Boolean(bot.getMonitorBusy?.()), positionsCount: positions.length, lastCheck: global.LAST_MONITOR_CHECK || null, positions: positions.map((p) => ({ symbol: p.symbol, mint: p.mint, investedSol: p.investedSol, ageMinutes: Math.floor((Date.now() - p.openedAt) / 60000) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/ping', (_req, res) => res.status(200).send('pong'));
app.get('/cron-ping', (_req, res) => res.status(200).json({ status: 'awake', ts: Date.now(), uptime: process.uptime() }));
let heartbeatTimer = null;
function startHeartbeat() { if (heartbeatTimer) return; const base = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || ''; if (!base) return; heartbeatTimer = setInterval(() => { fetch(`${base.replace(/\/$/, '')}/cron-ping`).catch(() => {}); }, 5 * 60 * 1000); heartbeatTimer.unref(); }
function startHealthServer() { if (server) return server; botStarted = true; global.START_TIME = new Date().toISOString(); server = app.listen(PORT, () => { console.log(`Health server listening on ${PORT}`); startHeartbeat(); }); return server; }
module.exports = { app, startHealthServer };
