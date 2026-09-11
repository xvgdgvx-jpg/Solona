const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const bot = require('./bot');
const { startHealthServer } = require('./health-server');

const lockPath = path.join(__dirname, 'data', 'bot.lock');
let lockOwned = false;

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireLock() {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (isProcessAlive(Number(lock.pid))) {
        console.error(`[bot] Another instance is already running (PID ${lock.pid}). Exiting.`);
        return false;
      }
      console.warn(`[bot] Removing stale lock file for PID ${lock.pid || 'unknown'}.`);
      fs.unlinkSync(lockPath);
    } catch (error) {
      console.warn(`[bot] Removing invalid lock file: ${error.message}`);
      try { fs.unlinkSync(lockPath); } catch (_) {}
    }
  }
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
    lockOwned = true;
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') {
      console.error('[bot] Another instance acquired the lock. Exiting.');
      return false;
    }
    throw error;
  }
}

function releaseLock() {
  if (!lockOwned) return;
  try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') console.error(`[bot] Lock cleanup error: ${error.message}`); }
  lockOwned = false;
}

if (!acquireLock()) process.exit(1);
process.once('exit', releaseLock);

let botStarting = false;
let botReady = false;
let lastBotError = null;
let shuttingDown = false;
const server = startHealthServer();
let retryDelayMs = 5000;
let retryTimer = null;
const conflictMessage = '[telegram] ⚠️ Conflict — نسخة أخرى تعمل بنفس التوكن. تحقق من: 1) Render services, 2) keep-alive.js, 3) تشغيل محلي';
const isConflict = (error) => error?.error_code === 409 || error?.description?.includes('Conflict') || error?.message?.includes('Conflict');
const startBot = async () => {
  if (shuttingDown || botStarting || botReady) return;
  botStarting = true;
  try {
    const polling = bot.start();
    botReady = true;
    retryDelayMs = 5000;
    lastBotError = null;
    console.log('Telegram bot started');
    polling.catch((error) => {
      if (shuttingDown) return;
      botReady = false;
      lastBotError = error.description || error.message;
      if (isConflict(error)) {
        console.warn(`${conflictMessage} — انتظار 30 ثانية ثم إعادة المحاولة`);
        retryTimer = setTimeout(startBot, 30000);
        return;
      }
      console.error(`Telegram polling stopped; retrying in ${retryDelayMs / 1000}s: ${lastBotError}`);
      retryTimer = setTimeout(startBot, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 60000);
    });
  } catch (error) {
    botReady = false;
    lastBotError = error.description || error.message;
    if (isConflict(error)) {
      console.warn(`${conflictMessage} — انتظار 30 ثانية ثم إعادة المحاولة`);
      retryTimer = setTimeout(startBot, 30000);
      return;
    }
    console.error(`Telegram startup failed; retrying in ${retryDelayMs / 1000}s: ${lastBotError}`);
    if (!shuttingDown) retryTimer = setTimeout(startBot, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, 60000);
  } finally {
    botStarting = false;
  }
};

startBot();
const shutdown = async (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: shutting down`);
  if (retryTimer) clearTimeout(retryTimer);
  try { await bot.stop(); } catch (error) { console.error(`Telegram stop error: ${error.message}`); }
  server.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(exitCode), 5000).unref();
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => { console.error(`Unhandled promise rejection: ${reason?.stack || reason}`); });
process.on('uncaughtException', (error) => { console.error(`Uncaught exception: ${error.stack || error.message}`); shutdown('UNCAUGHT_EXCEPTION', 1); });
