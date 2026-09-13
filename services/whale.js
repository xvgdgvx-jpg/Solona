const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class WhaleWatcher {
  constructor({ rpcUrl, wallet, pollMs = 5000, onSignal, onError }) {
    this.rpcUrl = rpcUrl;
    this.wallet = wallet || null;
    this.pollMs = Math.max(3000, Number(pollMs) || 5000);
    this.onSignal = onSignal || (() => {});
    this.onError = onError || (() => {});
    this.running = false;
    this.seen = new Set();
    this.lastPollAt = null;
    this.lastSignal = null;
    this.loopPromise = null;
  }

  setWallet(wallet) {
    this.wallet = wallet || null;
    this.seen.clear();
    this.lastSignal = null;
  }

  status() {
    return {
      running: this.running,
      wallet: this.wallet,
      lastPollAt: this.lastPollAt,
      lastSignal: this.lastSignal,
      seen: this.seen.size,
    };
  }

  async rpc(method, params) {
    if (!this.rpcUrl) throw new Error('Whale watcher RPC غير مضبوط');
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
      jsonrpc: '2.0', id: Date.now(), method, params,
      }),
    });
    if (!response.ok) throw new Error(`Whale RPC HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || `${method} failed`);
    return data.result;
  }

  start() {
    if (this.running || !this.wallet) return false;
    this.running = true;
    this.loopPromise = this.loop();
    console.log(`[whale] monitoring ${this.wallet} every ${this.pollMs}ms`);
    return true;
  }

  stop() {
    this.running = false;
    this.loopPromise = null;
  }

  async loop() {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.onError(error);
      }
      await sleep(this.pollMs);
    }
  }

  async pollOnce() {
    if (!this.wallet) return;
    this.lastPollAt = new Date().toISOString();
    const signatures = await this.rpc('getSignaturesForAddress', [this.wallet, { limit: 25, commitment: 'confirmed' }]);
    const fresh = (signatures || []).reverse().filter((item) => item.signature && !item.err && !this.seen.has(item.signature));
    for (const item of fresh) {
      this.seen.add(item.signature);
      if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
      const tx = await this.rpc('getParsedTransaction', [item.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
      const signal = this.detectSignal(tx, item.signature);
      if (!signal) continue;
      this.lastSignal = signal;
      console.log(`[whale] ${signal.side} ${signal.mint} | ${signal.signature}`);
      await this.onSignal(signal);
    }
  }

  detectSignal(tx, signature) {
    const meta = tx?.meta;
    const message = tx?.transaction?.message;
    if (!meta || !message) return null;
    const keys = (message.accountKeys || []).map((key) => typeof key === 'string' ? key : key.pubkey);
    const walletIndex = keys.indexOf(this.wallet);
    if (walletIndex < 0) return null;

    const pre = new Map();
    const post = new Map();
    for (const row of meta.preTokenBalances || []) {
      if (row.owner === this.wallet) pre.set(row.mint, Number(row.uiTokenAmount?.uiAmount || 0));
    }
    for (const row of meta.postTokenBalances || []) {
      if (row.owner === this.wallet) post.set(row.mint, Number(row.uiTokenAmount?.uiAmount || 0));
    }

    const mints = new Set([...pre.keys(), ...post.keys()]);
    for (const mint of mints) {
      const tokenDelta = (post.get(mint) || 0) - (pre.get(mint) || 0);
      if (!Number.isFinite(tokenDelta) || Math.abs(tokenDelta) <= 0) continue;
      const solDelta = (Number(meta.postBalances?.[walletIndex] || 0) - Number(meta.preBalances?.[walletIndex] || 0)) / 1e9;
      const side = tokenDelta > 0 && solDelta < 0 ? 'buy' : tokenDelta < 0 && solDelta > 0 ? 'sell' : null;
      if (!side) continue;
      return {
        side,
        mint,
        tokenDelta,
        solDelta,
        signature,
        slot: tx.slot || null,
        blockTime: tx.blockTime || null,
        source: 'helius-rpc-wallet-monitor',
      };
    }
    return null;
  }
}

module.exports = { WhaleWatcher };
