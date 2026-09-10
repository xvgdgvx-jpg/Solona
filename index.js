const config = require('./config');
const bot = require('./bot');
const { startHealthServer } = require('./health-server');

let botStarting = false;
let botReady = false;
let lastBotError = null;
let shuttingDown = false;
const server = startHealthServer();
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
const shutdown = async (signal, exitCode = 0) => { if (shuttingDown) return; shuttingDown = true; console.log(`${signal}: shutting down`); clearInterval(supervisor); if (retryTimer) clearTimeout(retryTimer); try { await bot.stop(); } catch (error) { console.error(`Telegram stop error: ${error.message}`); } server.close(() => process.exit(exitCode)); setTimeout(() => process.exit(exitCode), 5000).unref(); };
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => { console.error(`Unhandled promise rejection: ${reason?.stack || reason}`); });
process.on('uncaughtException', (error) => { console.error(`Uncaught exception: ${error.stack || error.message}`); shutdown('UNCAUGHT_EXCEPTION', 1); });
