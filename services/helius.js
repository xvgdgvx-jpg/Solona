const axios = require('axios');
const WebSocket = require('ws');

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

class HeliusService {
  constructor({ apiKey, rpcUrl, wsUrl, onMint, onError, onState }) {
    console.log(`[helius] ENV check: apiKey=${!!process.env.HELIUS_API_KEY}, rpc=${!!process.env.HELIUS_RPC_URL}, ws=${!!process.env.HELIUS_WS_URL}`);
    apiKey = apiKey || process.env.HELIUS_API_KEY;
    rpcUrl = rpcUrl || process.env.HELIUS_RPC_URL;
    wsUrl = wsUrl || process.env.HELIUS_WS_URL;
    if (apiKey && !rpcUrl) {
      rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
      console.log('[helius] Derived RPC URL from API key');
    }
    if (apiKey && !wsUrl) {
      wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
      console.log('[helius] Derived WS URL from API key');
    }
    console.log(`[helius] Effective: apiKey=${apiKey ? 'set' : 'missing'}, rpcUrl=${rpcUrl ? 'set' : 'missing'}, wsUrl=${wsUrl ? 'set' : 'missing'}`);
    this.apiKey = apiKey;
    this.rpcUrl = rpcUrl;
    this.wsUrl = wsUrl;
    this.onMint = onMint;
    this.onError = onError;
    this.onState = onState || (() => {});
    this.ws = null;
    this.wsPing = null;
    this.reconnectTimer = null;
    this.connectionTimeout = null;
    this.noEventTimer = null;
    this.fallbackTimer = null;
    this.fallbackActive = false;
    this.noEventWarningShown = false;
    this.lastEventAt = null;
    this.lastError = null;
    this.subscriptionId = null;
    this.stopped = true;
  }

  enabled() { return Boolean(this.apiKey && this.rpcUrl && this.wsUrl); }

  start() {
    if (!this.enabled() || !this.stopped) return false;
    this.stopped = false;
    console.log('[helius] Starting WebSocket connection...');
    try { this.connect(); return true; } catch (error) { this.stopped = true; this.reportError(error); return false; }
  }

  stop() {
    this.stopped = true;
    this.onState(false);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    if (this.wsPing) clearInterval(this.wsPing);
    if (this.noEventTimer) clearInterval(this.noEventTimer);
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.reconnectTimer = null;
    this.connectionTimeout = null;
    this.wsPing = null;
    this.noEventTimer = null;
    this.fallbackTimer = null;
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  reportError(error) {
    this.lastError = error.message;
    console.error(`[helius] ❌ Error: ${error.message}`);
    this.onError(error);
  }

  connect() {
    if (this.stopped) return;
    try { this.ws = new WebSocket(this.wsUrl); } catch (error) { this.reportError(error); this.stopped = true; return; }
    this.connectionTimeout = setTimeout(() => {
      if (this.ws?.readyState !== WebSocket.OPEN && !this.stopped) {
        const error = new Error('HELIUS_CONNECT_TIMEOUT');
        error.code = 'HELIUS_CONNECT_TIMEOUT';
        console.error('[helius] ❌ Failed to connect within 5s — falling back to REST');
        this.reportError(error);
        this.ws?.close();
      }
    }, 5000);
    this.ws.on('open', () => {
      if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
      console.log('[helius] ✅ WebSocket connected successfully');
      console.log('[helius] ✅ Stream opened');
      this.lastEventAt = Date.now();
      this.noEventWarningShown = false;
      this.fallbackActive = false;
      this.onState(true);
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'transactionSubscribe', params: [{ failed: false, accountInclude: [PUMP_PROGRAM_ID] }, { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 1 }] }));
      if (this.wsPing) clearInterval(this.wsPing);
      if (this.noEventTimer) clearInterval(this.noEventTimer);
      this.wsPing = setInterval(() => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping(); }, 10000);
      this.noEventTimer = setInterval(() => this.checkEventHealth(), 10000);
    });
    this.ws.on('message', (raw) => this.handleMessage(raw));
    this.ws.on('error', (error) => this.reportError(error));
    this.ws.on('close', (code, reasonBuffer) => {
      if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
      if (this.wsPing) clearInterval(this.wsPing);
      if (this.noEventTimer) clearInterval(this.noEventTimer);
      this.connectionTimeout = null;
      this.wsPing = null;
      this.noEventTimer = null;
      const reason = reasonBuffer?.toString() || 'none';
      console.log(`[helius] ⚠️ Stream closed: code=${code}, reason=${reason}`);
      this.ws = null;
      if (!this.stopped && !this.fallbackActive) this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });
  }

  checkEventHealth() {
    if (this.stopped || this.fallbackActive || !this.lastEventAt) return;
    const elapsed = Date.now() - this.lastEventAt;
    if (elapsed >= 30000 && !this.noEventWarningShown) {
      this.noEventWarningShown = true;
      console.warn('[helius] ⚠️ No events received in 30s — subscription may be dead');
    }
    if (elapsed >= 60000) this.pauseForRestFallback();
  }

  pauseForRestFallback() {
    if (this.stopped || this.fallbackActive) return;
    this.fallbackActive = true;
    this.onState(false);
    console.warn('[helius] ⚠️ No events received in 60s — pausing WebSocket and using REST');
    if (this.noEventTimer) clearInterval(this.noEventTimer);
    if (this.wsPing) clearInterval(this.wsPing);
    this.noEventTimer = null;
    this.wsPing = null;
    if (this.ws) this.ws.close();
    this.ws = null;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      if (this.stopped) return;
      console.log('[helius] Retrying WebSocket after 2-minute REST fallback');
      this.fallbackActive = false;
      this.lastEventAt = Date.now();
      this.connect();
    }, 120000);
  }

  handleMessage(raw) {
    try {
      const payload = JSON.parse(raw.toString());
      this.lastEventAt = Date.now();
      if (payload.id === 1 && payload.result != null) {
        this.subscriptionId = payload.result;
        console.log(`[helius] ✅ Pump.fun subscription registered: ${this.subscriptionId}`);
        return;
      }
      const result = payload.params?.result;
      const logs = result?.transaction?.meta?.logMessages || [];
      if (!result || !logs.some((log) => log.includes('Instruction: InitializeMint2'))) return;
      const keys = result.transaction?.transaction?.message?.accountKeys || [];
      const pubkeys = keys.map((key) => typeof key === 'string' ? key : key.pubkey).filter(Boolean);
      const mint = pubkeys.find((key) => key.length >= 32 && key !== PUMP_PROGRAM_ID);
      if (mint) this.onMint({ mint, creator: pubkeys[0], signature: result.signature, source: 'helius-websocket' });
    } catch (error) { this.reportError(error); }
  }

  async rpc(method, params) {
    if (!this.rpcUrl) throw new Error('HELIUS_API_KEY غير مضبوط');
    const { data } = await axios.post(this.rpcUrl, { jsonrpc: '2.0', id: Date.now(), method, params }, { timeout: 10000 });
    if (data.error) throw new Error(data.error.message || `${method} failed`);
    return data.result;
  }

  async getAsset(id) { return this.rpc('getAsset', { id, displayOptions: { showFungible: true, showInscription: false } }); }

  async enrichToken(mint, creator = null, bondingCurve = null) {
    let asset;
    let largest;
    try {
      [asset, largest] = await Promise.all([this.getAsset(mint), this.rpc('getTokenLargestAccounts', [mint])]);
    } catch (error) {
      console.warn(`[helius] enrichToken: no data for ${mint}`);
      return { heliusVerified: false };
    }
    if (!asset || !largest || !Array.isArray(largest.value)) {
      console.warn(`[helius] enrichToken: no data for ${mint}`);
      return { heliusVerified: false };
    }
    const tokenInfo = asset.token_info || {};
    const decimals = Number(tokenInfo.decimals ?? asset.content?.metadata?.decimals ?? 6);
    const rawSupply = Number(tokenInfo.supply);
    const supply = Number.isFinite(rawSupply) && rawSupply > 0 ? rawSupply / (10 ** decimals) : null;
    const rows = largest.value;
    if (!asset || rows.length === 0) {
      console.warn(`[helius] enrichToken: no data for ${mint}`);
      return { heliusVerified: false };
    }
    const excluded = new Set([bondingCurve].filter(Boolean));
    const topTen = rows.filter((row) => !excluded.has(row.address)).slice(0, 10);
    const topTenAmount = topTen.reduce((sum, row) => sum + Number(row.amount || 0) / (10 ** decimals), 0);
    let creatorAmount = null;
    if (creator) {
      try {
        const accounts = await this.rpc('getTokenAccountsByOwner', [creator, { mint }, { encoding: 'jsonParsed' }]);
        creatorAmount = (accounts?.value || []).reduce((sum, item) => sum + Number(item.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
      } catch (_) { creatorAmount = null; }
    }
    const metadata = asset.content?.metadata || {};
    const links = asset.content?.links || {};
    const social = [metadata.twitter, metadata.telegram, metadata.website, links.twitter, links.telegram, links.external_url].filter(Boolean);
    const creatorHoldingsPct = supply && creatorAmount !== null ? (creatorAmount / supply) * 100 : null;
    const topHoldersPct = supply && rows.length > 0 ? (topTenAmount / supply) * 100 : null;
    return {
      decimals,
      supply,
      creator,
      creatorHoldingsPct,
      topHoldersPct,
      uniqueBuyers: null,
      uniqueSellers: null,
      volumeUsd: null,
      buyVolumeUsd: null,
      sellVolumeUsd: null,
      creatorSold: null,
      socialLinks: social,
      metadataName: metadata.name || '',
      metadataSymbol: metadata.symbol || '',
      heliusVerified: Number.isFinite(creatorHoldingsPct) && Number.isFinite(topHoldersPct),
    };
  }
}

module.exports = { HeliusService, PUMP_PROGRAM_ID };
