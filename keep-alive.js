const { spawn } = require('node:child_process');

let child = null;
let stopping = false;
let restartDelay = 2000;
let restartTimer = null;

function startChild() {
  if (stopping || child) return;
  console.log(`[supervisor] starting bot process (restart delay=${restartDelay}ms)`);
  child = spawn(process.execPath, ['index.js'], {
    cwd: __dirname,
    env: process.env,
    stdio: 'inherit'
  });

  child.once('error', (error) => {
    console.error(`[supervisor] child process error: ${error.stack || error.message}`);
  });

  child.once('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    console.error(`[supervisor] bot exited unexpectedly (code=${code ?? 'null'}, signal=${signal || 'none'}); restarting in ${restartDelay}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startChild();
    }, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 60000);
  });

  // A successfully running child resets the backoff after a stable period.
  setTimeout(() => {
    if (child) restartDelay = 2000;
  }, 30000).unref();
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  console.log(`[supervisor] ${signal}: stopping bot`);
  if (!child) process.exit(0);
  const current = child;
  const forceKill = setTimeout(() => {
    if (current.exitCode === null) current.kill('SIGKILL');
  }, 10000);
  forceKill.unref();
  current.once('exit', () => process.exit(0));
  current.kill(signal);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => console.error(`[supervisor] uncaught exception: ${error.stack || error.message}`));
process.on('unhandledRejection', (reason) => console.error(`[supervisor] unhandled rejection: ${reason?.stack || reason}`));

startChild();
