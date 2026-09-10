const axios = require('axios');
const WebSocket = require('ws');

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

class HeliusService {
  constructor({ apiKey, rpcUrl, wsUrl, onMint, onError }) {
    this.apiKey = apiKey;
    this.rpcUrl = rpcUrl || (apiKey ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}` : null);
    this.wsUrl = wsUrl || (apiKey ? `wss://mainnet.helius-rpc.com/?api-key=${apiKey}` : null);
    this.onMint = onMint;
    this.onError = onError;
    this.ws = null;
    this.reconnectTimer = null;
    this.stopped = true;
  }

  enabled() { return Boolean(this.apiKey && this.rpcUrl && this.wsUrl); }

  start() {
    if (!this.enabled() || !this.stopped) return false;
    this.stopped = false;
    this.connect();
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  connect() {
    if (this.stopped) return;
    this.ws = new WebSocket(this.wsUrl);
    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'transactionSubscribe', params: [{ failed: false, accountInclude: [PUMP_PROGRAM_ID] }, { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 1 }] }));
      this.wsPing = setInterval(() => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping(); }, 10000);
    });
    this.ws.on('message', (raw) => this.handleMessage(raw));
    this.ws.on('error', (error) => this.onError(error));
    this.ws.on('close', () => {
      if (this.wsPing) clearInterval(this.wsPing);
      this.ws = null;
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });
  }

  handleMessage(raw) {
    try {
      const payload = JSON.parse(raw.toString());
      const result = payload.params?.result;
      const logs = result?.transaction?.meta?.logMessages || [];
      if (!result || !logs.some((log) => log.includes('Instruction: InitializeMint2'))) return;
      const keys = result.transaction?.transaction?.message?.accountKeys || [];
      const pubkeys = keys.map((key) => typeof key === 'string' ? key : key.pubkey).filter(Boolean);
      const mint = pubkeys.find((key) => key.length >= 32 && key !== PUMP_PROGRAM_ID);
      if (mint) this.onMint({ mint, creator: pubkeys[0], signature: result.signature, source: 'helius-websocket' });
    } catch (error) { this.onError(error); }
  }

  async rpc(method, params) {
    if (!this.rpcUrl) throw new Error('HELIUS_API_KEY غير مضبوط');
    const { data } = await axios.post(this.rpcUrl, { jsonrpc: '2.0', id: Date.now(), method, params }, { timeout: 10000 });
    if (data.error) throw new Error(data.error.message || `${method} failed`);
    return data.result;
  }

  async getAsset(id) { return this.rpc('getAsset', { id, displayOptions: { showFungible: true, showInscription: false } }); }

  async enrichToken(mint, creator = null, bondingCurve = null) {
    const [asset, largest] = await Promise.all([this.getAsset(mint), this.rpc('getTokenLargestAccounts', [mint])]);
    const tokenInfo = asset?.token_info || {};
    const decimals = Number(tokenInfo.decimals ?? asset?.content?.metadata?.decimals ?? 6);
    const supply = Number(tokenInfo.supply || 0) / (10 ** decimals);
    const rows = largest?.value || [];
    const excluded = new Set([bondingCurve].filter(Boolean));
    const topTen = rows.filter((row) => !excluded.has(row.address)).slice(0, 10);
    const topTenAmount = topTen.reduce((sum, row) => sum + Number(row.amount || 0) / (10 ** decimals), 0);
    let creatorAmount = 0;
    if (creator) {
      try {
        const accounts = await this.rpc('getTokenAccountsByOwner', [creator, { mint }, { encoding: 'jsonParsed' }]);
        creatorAmount = (accounts?.value || []).reduce((sum, item) => sum + Number(item.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
      } catch (_) {}
    }
    const metadata = asset?.content?.metadata || {};
    const links = asset?.content?.links || {};
    const social = [metadata.twitter, metadata.telegram, metadata.website, links.twitter, links.telegram, links.external_url].filter(Boolean);
    return {
      decimals,
      supply,
      creator,
      creatorHoldingsPct: supply > 0 ? (creatorAmount / supply) * 100 : 100,
      topHoldersPct: supply > 0 ? (topTenAmount / supply) * 100 : 100,
      socialLinks: social,
      metadataName: metadata.name || asset?.content?.metadata?.name || '',
      metadataSymbol: metadata.symbol || '',
      heliusVerified: true
    };
  }
}

module.exports = { HeliusService, PUMP_PROGRAM_ID };
