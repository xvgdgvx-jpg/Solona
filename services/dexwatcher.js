const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentFromRawAmounts = (part, total) => {
  try {
    const numerator = BigInt(String(part));
    const denominator = BigInt(String(total));
    if (denominator <= 0n || numerator < 0n) return null;
    return Number(numerator * 1000000n / denominator) / 10000;
  } catch (_) {
    return null;
  }
};
const SOL_MINT_ADDR = 'So11111111111111111111111111111111111111112';
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const ALLOWED_DEXES_BY_MODE = { raydium: ['raydium'], raydium_orca: ['raydium', 'orca'], raydium_orca_meteora: ['raydium', 'orca', 'meteora', 'meteora_daam_v2', 'meteora_dbc'], all: null };
function normalizedDexId(value) {
  const id = String(value || '').trim().toLowerCase().replace(/[-\s]/g, '_');
  if (id === 'raydium' || id.startsWith('raydium_')) return 'raydium';
  if (id === 'orca' || id.startsWith('orca_') || id.startsWith('orca_whirlpool')) return 'orca';
  if (id === 'meteora' || id.startsWith('meteora_')) return id.includes('dbc') ? 'meteora_dbc' : id.includes('daam') || id.includes('dlmm') ? 'meteora_daam_v2' : 'meteora';
  return id;
}

class DexWatcher {
  constructor({ settings, getSettings, onCandidate, onError, onFilter }) {
    this.settings = settings; this.getSettings = getSettings || null; this.onCandidate = onCandidate; this.onError = onError || (() => {}); this.onFilter = onFilter || (() => {});
    this.running = false; this.timer = null; this.watchdog = null; this.statusTimer = setInterval(() => console.log(`[dexwatcher-status] checked=${this.checkedCount} seen=${this.seen.size} polls=${this.pollCount} lastPoll=${this.lastPollAt} dur=${this.lastPollDurationMs}ms err=${this.lastError || 'none'}`), 60000); this.statusTimer.unref(); this.lastPollAt = null; this.lastError = null;
    this.lastCandidate = null; this.seen = new Set(); this.checked = 0; this.checkedCount = 0; this.pollCount = 0; this.pollInFlight = false; this.lastPollDurationMs = null; this.lastRequestDurationMs = null; this.lastPollStarted = null; this.startedAt = new Date().toISOString(); this.source = 'DexPaprika'; this.rejectStats = {}; this.passCount = 0; this.rejectCount = 0; this.rejectByStage = { dex: 0, onchain: 0, goplus: 0, tracker: 0 }; this.onChainCache = new Map(); this.lastRpcError = null; this.adminId = process.env.ADMIN_TELEGRAM_ID; this.encryptionKey = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');
    this.lastRequestStatus = null; this.uniqueMintsLastPoll = 0; this.nextCursor = null; this.lastSeenAt = null; this.cursorPolls = 0;
    this.discoveryUrl = process.env.DEXPAPRIKA_URL || 'https://api.dexpaprika.com/networks/solana/pools/search';
    this.nextAllowedPollAt = 0; this.lastRateLimitNoticeAt = 0; this.lastRequestStatus = null; this.openSymbolsCache = [];
  }
  updateSettings(settings) { this.settings = settings; }
  refreshSettings() {
    if (this.getSettings) this.settings = this.getSettings();
    return this.settings;
  }
  start() {
    if (this.running) return true;
    this.running = true; this.poll();
    this.timer = setInterval(() => this.poll(), 5000);
    this.watchdog = setInterval(() => { if (this.running && (!this.lastPollAt || Date.now() - new Date(this.lastPollAt).getTime() > 20000)) { clearInterval(this.timer); this.timer = setInterval(() => this.poll(), 5000); this.poll(); } }, 60000);
    return true;
  }
  stop() { this.running = false; if (this.timer) clearInterval(this.timer); if (this.watchdog) clearInterval(this.watchdog); if (this.statusTimer) clearInterval(this.statusTimer); this.timer = this.watchdog = this.statusTimer = null; }
  reset() { this.seen.clear(); this.lastError = null; this.lastCandidate = null; this.checked = 0; this.checkedCount = 0; this.pollCount = 0; this.lastPollAt = null; this.lastPollDurationMs = null; this.lastRequestDurationMs = null; this.lastPollStarted = null; this.nextAllowedPollAt = 0; this.rejectStats = {}; this.passCount = 0; this.rejectCount = 0; this.rejectByStage = { dex: 0, onchain: 0, goplus: 0, tracker: 0 }; this.onChainCache = new Map(); this.lastRpcError = null; this.nextCursor = null; this.lastSeenAt = null; this.cursorPolls = 0; this.uniqueMintsLastPoll = 0; }
  status() { return { running: this.running, source: this.source, checked: this.checkedCount, seen: this.seen.size, lastPollAt: this.lastPollAt, lastPollDurationMs: this.lastPollDurationMs, lastRequestDurationMs: this.lastRequestDurationMs, lastError: this.lastError, lastMint: this.lastCandidate?.mint || null, lastSymbol: this.lastCandidate?.symbol || null, rejectStats: this.rejectStats, passCount: this.passCount, rejectCount: this.rejectCount, rejectByStage: this.rejectByStage, lastRpcError: this.lastRpcError, uniqueMintsLastPoll: this.uniqueMintsLastPoll || 0, lastSeenAt: this.lastSeenAt, nextCursor: this.nextCursor ? 'set' : null, cursorPolls: this.cursorPolls || 0, onChainCacheSize: this.onChainCache.size, pollCount: this.pollCount, startedAt: this.startedAt, uptime: process.uptime() }; }
  async request(url, options = {}) {
    const attempts = Number(options.retries ?? 2); const requestOptions = { timeout: 10000, headers: { 'User-Agent': 'Solana-DexPaprika-Watcher/1.0', 'Cache-Control': 'no-cache', Pragma: 'no-cache', ...(options.headers || {}) }, ...options }; delete requestOptions.retries;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      try { this.lastRequestStatus = null; return (await axios.get(url, requestOptions)).data; }
      catch (error) {
        const status = error.response?.status; this.lastRequestStatus = status || null;
        if (status === 429 && attempt < attempts) { await sleep(Math.min(15000, Math.max(1000, (attempt + 1) * 2000))); continue; }
        this.lastError = error.message; if (Date.now() - this.lastRateLimitNoticeAt > 60000) { this.lastRateLimitNoticeAt = Date.now(); this.onError(error); } return null;
      }
    }
    return null;
  }
  async poll() {
    if (!this.running || this.pollInFlight || Date.now() < this.nextAllowedPollAt) return;
    this.refreshSettings();
    if (!this.settings || this.settings.autoWatcherEnabled === false || this.settings.killSwitch === true) return;
    this.pollInFlight = true;
    this.lastPollStarted = Date.now();
    const startedAt = this.lastPollStarted;
    this.lastPollAt = startedAt;
    this.pollCount = (this.pollCount || 0) + 1;
    let newCount = 0;
    try {
      const now = Math.floor(Date.now() / 1000);
      const windowStart = this.lastSeenAt || (now - 3600);
      const configuredMinLiquidity = Math.max(0, Number(this.settings.dex?.minLiquidityUsd ?? 0) || 0);
      const baseParams = { order_by: 'created_at', sort: 'desc', limit: 100, detailed: true, min_liquidity_usd: configuredMinLiquidity };
      const params = this.nextCursor ? { ...baseParams, cursor: this.nextCursor } : { ...baseParams, created_after: windowStart };
      this.lastRequestStatus = null;
      const requestStart = Date.now();
      let data = await this.request(this.discoveryUrl, { params });
      this.lastRequestDurationMs = Date.now() - requestStart;
      if (!data && this.nextCursor && this.lastRequestStatus === 400) {
        console.warn('[dexwatcher] cursor rejected; falling back to created_after window');
        this.nextCursor = null;
        this.cursorPolls = 0;
        this.lastRequestStatus = null;
        data = await this.request(this.discoveryUrl, { params: { ...baseParams, created_after: windowStart } });
      }
      if (!data && this.lastRequestStatus === 400) {
        console.warn('[dexwatcher] DexPaprika rejected advanced params; retrying basic order');
        this.lastRequestStatus = null;
        data = await this.request(this.discoveryUrl, { params: { order_by: 'created_at', sort: 'desc', limit: 100, detailed: true } });
      }
      if (!data) { this.nextAllowedPollAt = Date.now() + 60000; return; }
      const pools = Array.isArray(data) ? data : (data?.results || data?.pools || data?.data || []);
      const responseCursor = Array.isArray(data) ? null : (data?.next_cursor || null);
      if (!this.nextCursor && responseCursor) this.nextCursor = responseCursor;
      else if (this.nextCursor) this.nextCursor = responseCursor;
      this.cursorPolls += 1;
      if (this.cursorPolls >= 12) {
        this.nextCursor = null;
        this.cursorPolls = 0;
        console.log('[dexwatcher] reset cursor to fetch newest pools');
      }
      let maxCreated = windowStart;
      for (const pool of pools) {
        const ts = typeof pool?.created_at === 'number' ? pool.created_at : (pool?.created_at ? Date.parse(pool.created_at) / 1000 : 0);
        if (Number.isFinite(ts) && ts > maxCreated) maxCreated = ts;
      }
      if (maxCreated > windowStart) this.lastSeenAt = maxCreated - 1;
      console.log(`[dexwatcher] poll#${this.pollCount} cursor=${this.nextCursor ? 'yes' : 'no'} has_next=${Array.isArray(data) ? 'n/a' : Boolean(data?.has_next_page)} created_after=${windowStart} fetched=${pools.length}`);

      const mode = this.settings.dex.allowedDexes || 'all';
      const allowedList = ALLOWED_DEXES_BY_MODE[mode] ?? null;
      const bestPoolByMint = new Map();
      for (const pool of pools) {
        const tokens = Array.isArray(pool?.tokens) ? pool.tokens : [];
        const token = tokens.find((item) => item?.id && item.id !== SOL_MINT_ADDR) || tokens[0];
        const mint = token?.id;
        if (!mint || mint === SOL_MINT_ADDR) continue;
        const poolDex = normalizedDexId(pool?.dex_id || pool?.dex_name);
        if (allowedList && !allowedList.includes(poolDex)) continue;
        const liquidityUsd = Number(pool?.liquidity_usd || 0);
        const existing = bestPoolByMint.get(mint);
        if (!existing || liquidityUsd > existing.liquidityUsd) bestPoolByMint.set(mint, { pool, liquidityUsd });
      }
      this.uniqueMintsLastPoll = bestPoolByMint.size;
      console.log(`[dexwatcher] poll#${this.pollCount} unique_mints=${this.uniqueMintsLastPoll}`);
      for (const [mint, dataByMint] of bestPoolByMint) {
        if (dataByMint.liquidityUsd < 100) console.log(`[aggregate] ${mint}: only pool liq=$${dataByMint.liquidityUsd.toFixed(2)} (best available)`);
      }

      const queue = Array.from(bestPoolByMint.values(), (item) => item.pool);
      const CONCURRENCY = 10;
      const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, async () => {
        while (queue.length) {
          const pool = queue.shift();
          if (!pool) break;
          const candidate = this.loadCandidate(pool);
          if (!candidate || !candidate.createdAt || this.seen.has(candidate.mint)) continue;
          this.seen.add(candidate.mint);
          this.checkedCount += 1;
          this.checked = this.checkedCount;
          newCount += 1;
          try { await this.evaluate(candidate); } catch (error) { console.error('[eval] ' + error.message); }
        }
      });
      await Promise.all(workers);
    } catch (error) {
      this.lastError = error.message;
      this.onError(error);
    } finally {
      this.lastPollDurationMs = Date.now() - startedAt;
      this.lastPollAt = new Date().toISOString();
      console.log(`[dexwatcher] poll#${this.pollCount} done — new=${newCount} checked=${this.checkedCount} seen=${this.seen.size} duration=${this.lastPollDurationMs}ms`);
      this.pollInFlight = false;
    }
  }
  loadCandidate(pool) {
    try {
      const tokens = Array.isArray(pool.tokens) ? pool.tokens : [];
      const token = tokens.find((t) => t?.id && t.id !== SOL_MINT_ADDR) || tokens[0];
      const mint = token?.id;
      if (!mint || mint === SOL_MINT_ADDR) return null;
      const txns = pool.txns_24h ?? pool.transactions_24h; const buys = Number(txns?.buys ?? txns?.buy ?? txns?.buy_count ?? txns ?? 0); const sells = Number(txns?.sells ?? txns?.sell ?? txns?.sell_count ?? 0);
      const created = typeof pool.created_at === 'number' ? pool.created_at : (pool.created_at ? Date.parse(pool.created_at) / 1000 : null);
      const ageSec = Number.isFinite(created) ? Math.max(0, Date.now() / 1000 - created) : null;
      const period24 = pool['24h'] || pool['24H'] || pool.volume_24h || {};
      const marketCapUsd = Number(token.fdv ?? token.fdv_usd ?? pool.fdv_usd ?? pool.market_cap_usd ?? 0) || null;
      const liquidityUsd = Number(pool.liquidity_usd ?? pool.liquidityUsd ?? 0) || 0;
      const volumeUsd = Number(pool.volume_usd_24h ?? pool.volume_usd ?? period24.volume_usd ?? period24.volume ?? 0) || 0;
      const priceUsd = Number(pool.price_usd ?? pool.last_price_usd ?? token.price_usd ?? 0) || null;
      return { mint, name: token.name || token.symbol || 'بدون اسم', symbol: token.symbol || 'N/A', decimals: Number(token.decimals || 6), createdAt: Number.isFinite(created) ? created : null, ageSec, marketCapUsd, priceUsd, liquidityUsd, volumeUsd, dexBuys: buys, dexSells: sells, buySellRatio: buys / Math.max(1, sells), mintAuthority: null, freezeAuthority: null, poolAddress: pool.id, creator: pool.creator || pool.created_by || token.creator || token.created_by || null, dexName: pool.dex_name || pool.dex_id, marketDataSource: 'dexpaprika', source: 'dexpaprika' };
    } catch (_) { return null; }
  }
  async evaluate(candidate) {
    const currentSettings = this.refreshSettings();
    const dex = currentSettings.dex || {};
    const age = candidate.createdAt ? Math.max(0, Date.now() / 1000 - candidate.createdAt) : null;
    const threshold = (value) => { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : 0; };
    const minAgeSec = threshold(dex.minAgeSec);
    const maxAgeSec = threshold(dex.maxAgeSec);
    const minVolumeUsd = threshold(dex.minVolumeUsd);
    const minLiquidityUsd = threshold(dex.minLiquidityUsd);
    const minBuys24h = threshold(dex.minBuys24h);
    const minBuySellRatio = threshold(dex.minBuySellRatio);
    const minMarketCapUsd = threshold(dex.minMarketCapUsd);
    const maxMarketCapUsd = threshold(dex.maxMarketCapUsd);
    const fail = (reason, stage) => { const key = `${stage}: ${reason}`; this.rejectStats[key] = (this.rejectStats[key] || 0) + 1; this.rejectCount += 1; this.rejectByStage[stage] = (this.rejectByStage[stage] || 0) + 1; this.onFilter(candidate, reason, stage); return false; };
    if (!candidate.mint || (() => { try { new PublicKey(candidate.mint); return false; } catch (_) { return true; } })()) return fail('عنوان العملة غير صالح', 'dex');
    if (age != null && (age < minAgeSec || (maxAgeSec > 0 && age > maxAgeSec))) return fail('العمر خارج الحدود', 'dex');
    if (Number(candidate.volumeUsd || 0) < minVolumeUsd || Number(candidate.liquidityUsd || 0) < minLiquidityUsd) return fail('الحجم أو السيولة أقل من الحد', 'dex');
    if (Number(candidate.dexBuys || 0) < minBuys24h || Number(candidate.buySellRatio || 0) < minBuySellRatio) return fail('المشتريات أو نسبة الشراء/البيع أقل من الحد', 'dex');
    if (Number(candidate.marketCapUsd || 0) < minMarketCapUsd || (maxMarketCapUsd > 0 && Number(candidate.marketCapUsd || 0) > maxMarketCapUsd)) return fail('القيمة السوقية خارج الحدود', 'dex');
    const allowedList = ALLOWED_DEXES_BY_MODE[dex.allowedDexes || 'all'] ?? null;
    if (allowedList && !allowedList.includes(normalizedDexId(candidate.dexName))) return fail(`الـ DEX غير مسموح: ${candidate.dexName || 'غير معروف'} (المسموح: ${dex.allowedDexes})`, 'dex');
    if (dex.antiDuplicate !== false) { const { getPositions } = require('./paper'); const openPositions = getPositions(this.adminId, this.encryptionKey).filter((p) => p.status === 'open'); const candidateSymbol = String(candidate.symbol || '').trim().toUpperCase(); if (candidateSymbol && openPositions.some((p) => String(p.symbol || '').trim().toUpperCase() === candidateSymbol)) return fail(`رمز مكرر (${candidateSymbol})`, 'dex'); }
    const oc = currentSettings.onchain || {};
    if (oc.enabled === true) { const onChainResult = await this.checkOnChain(candidate.mint); if (onChainResult.data?.rpcError) { this.lastRpcError = onChainResult.data.rpcError; return fail('On-Chain: RPC error', 'onchain'); } if (!onChainResult.passed) return fail(onChainResult.reason, 'onchain'); candidate.onChainData = onChainResult.data; }
    const gp = currentSettings.goplus || {};
    if (gp.enabled === true) { const result = await this.goplus(candidate.mint); if (!result) return fail('GoPlus: لا توجد بيانات', 'goplus'); if (!this.passGoplus(result)) return fail('رفض GoPlus: فشل فحص الأمان', 'goplus'); }
    const tk = currentSettings.tracker || {};
    if (tk.enabled === true) { const result = await this.tracker(candidate.mint); if (!result) return fail('Tracker: لا توجد بيانات', 'tracker'); if (!this.passTracker(result)) return fail('رفض Solana Tracker: تجاوز حدود المخاطر', 'tracker'); }
    if (tk.enabled === true && candidate.creator) { const rep = await this.checkDeployerReputation(candidate.mint, candidate.creator); if (!rep.passed) return fail(`منشئ مشبوه: ${rep.reason}`, 'tracker'); }
    this.lastCandidate = candidate; this.passCount += 1; await this.onCandidate(candidate); return true;
  }
  async checkOnChain(mint) {
    const cached = this.onChainCache.get(mint);
    if (cached && Date.now() - cached.timestamp < 3600000) return cached.result;
    const result = { passed: true, reason: null, data: {} };
    try {
      const rpcUrl = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
      const conn = new Connection(rpcUrl, 'confirmed');
      const mintInfo = await conn.getParsedAccountInfo(new PublicKey(mint));
      const info = mintInfo.value?.data?.parsed?.info;
      if (!info) { result.passed = false; result.reason = 'لا يمكن قراءة بيانات Mint'; }
      else {
        result.data = { mintAuthority: info.mintAuthority ?? null, freezeAuthority: info.freezeAuthority ?? null, supply: Number(info.supply || 0), decimals: Number(info.decimals || 0), updateAuthority: null };
        const oc = this.settings.onchain || {};
        if (oc.checkAuthorities !== false && (info.mintAuthority !== null || info.freezeAuthority !== null)) { result.passed = false; result.reason = info.mintAuthority !== null ? 'Mint Authority مفتوح' : 'Freeze Authority مفتوح'; }
        if (result.passed && oc.checkTop10 !== false && Number(oc.maxTop10Pct || 0) > 0) {
          const rows = (await conn.getTokenLargestAccounts(new PublicKey(mint))).value || [];
          const top10Raw = rows.slice(0, 10).reduce((sum, row) => sum + BigInt(String(row.amount || '0')), 0n);
          const pct = percentFromRawAmounts(top10Raw, info.supply);
          if (pct === null) { result.passed = false; result.reason = 'تعذر حساب تركيز Top 10 من بيانات السلسلة'; }
          else { result.data.top10Pct = pct; result.data.top10Raw = top10Raw.toString(); result.data.top10Accounts = Math.min(rows.length, 10); if (pct > Number(oc.maxTop10Pct)) { result.passed = false; result.reason = `تركيز Top 10: ${pct.toFixed(2)}% > ${oc.maxTop10Pct}%`; } }
        }
        if (result.passed && oc.checkSupply === true && Number(oc.maxSupply) > 0 && result.data.supply > Number(oc.maxSupply)) { result.passed = false; result.reason = `Supply ${result.data.supply} > ${oc.maxSupply}`; }
        if (result.passed && oc.checkDecimals === true && Number(oc.maxDecimals) > 0 && result.data.decimals > Number(oc.maxDecimals)) { result.passed = false; result.reason = `Decimals ${result.data.decimals} > ${oc.maxDecimals}`; }
        if (result.passed && oc.checkUpdateAuthority === true) { try { const [metadataAddress] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()], METADATA_PROGRAM_ID); const metadata = await conn.getAccountInfo(metadataAddress); if (metadata?.data?.length >= 33) { const authority = new PublicKey(metadata.data.subarray(1, 33)); result.data.updateAuthority = authority.toBase58(); if (!authority.equals(PublicKey.default)) { result.passed = false; result.reason = 'Update Authority مفتوح'; } } } catch (metadataError) { result.data.updateAuthorityError = metadataError.message; } }
      }
      this.onChainCache.set(mint, { result, timestamp: Date.now() });
      if (this.onChainCache.size > 5000) this.onChainCache.delete(this.onChainCache.keys().next().value);
      return result;
    } catch (error) { this.lastRpcError = error.message; return { passed: true, reason: null, data: { rpcError: error.message } }; }
  }
  async checkDeployerReputation(mint, creator) { const apiKey = process.env.SOLANA_TRACKER_API_KEY; const apiUrl = process.env.SOLANA_TRACKER_API_URL; if (!apiKey || !apiUrl || !creator) return { passed: true }; try { const { data } = await axios.get(`${apiUrl.replace(/\/$/, '')}/deployer/${creator}`, { headers: { 'x-api-key': apiKey }, timeout: 6000 }); const tokens = Array.isArray(data?.tokens) ? data.tokens : []; const limit = Number(this.settings.tracker?.maxDeveloperTokens || 0); if (limit > 0 && tokens.length > limit) return { passed: false, reason: `المنشئ أصدر ${tokens.length} عملة (الحد ${limit})` }; return { passed: true, count: tokens.length }; } catch (_) { return { passed: true }; } }
  async goplus(mint) { const result = await this.request(process.env.GOPLUS_API_URL || `https://api.gopluslabs.io/api/v1/token_security/solana?contract_addresses=${mint}`, { headers: process.env.GOPLUS_API_KEY ? { Authorization: `Bearer ${process.env.GOPLUS_API_KEY}` } : {} }).then((d) => d?.result?.[mint] || null); console.log(`[goplus] ${mint}: ${result ? 'has-data' : 'null'}`); return result; }
  async tracker(mint) { if (!process.env.SOLANA_TRACKER_API_URL) { console.log(`[tracker] ${mint}: null`); return null; } const result = await this.request(`${process.env.SOLANA_TRACKER_API_URL.replace(/\/$/, '')}/${mint}`, { headers: process.env.SOLANA_TRACKER_API_KEY ? { 'x-api-key': process.env.SOLANA_TRACKER_API_KEY } : {} }); console.log(`[tracker] ${mint}: ${result ? 'has-data' : 'null'}`); return result; }
  passGoplus(r) { const g = this.settings.goplus; const num = (...keys) => { for (const k of keys) if (r[k] != null) return Number(r[k]); return null; }; const buy = num('buy_tax', 'buy_tax_rate'); const sell = num('sell_tax', 'sell_tax_rate'); if (g.rejectHoneypot && ['1', 1, true, 'true'].includes(r.is_honeypot)) return false; if (buy != null && Number(g.maxBuyTax) >= 0 && buy > Number(g.maxBuyTax)) return false; if (sell != null && Number(g.maxSellTax) >= 0 && sell > Number(g.maxSellTax)) return false; if (g.checkMintAuthority && ['1', 1, true, 'true'].includes(r.mintable)) return false; if (g.checkFreezeAuthority && ['1', 1, true, 'true'].includes(r.freezable)) return false; return true; }
  passTracker(r) { const t = this.settings.tracker; const val = (...keys) => { for (const k of keys) if (r[k] != null) return Number(r[k]); return null; }; if (t.rejectRugged && (r.rugged === true || r.is_rugged === true)) return false; const checks = [[val('riskScore', 'risk_score'), t.maxRiskScore], [val('developerHoldingPct', 'developer_holding_percentage'), t.maxDeveloperHoldingPct], [val('developerTokens', 'developer_tokens', 'developerTokenCount'), t.maxDeveloperTokens], [val('snipersPct', 'snipers_percentage'), t.maxSnipersPct], [val('insidersPct', 'insiders_percentage'), t.maxInsidersPct], [val('bundlersPct', 'bundlers_percentage'), t.maxBundlersPct], [val('top10Pct', 'top_10_percentage'), t.maxTop10Pct]]; if (checks.some(([x, max]) => x != null && Number(max) > 0 && x > Number(max))) return false; const holders = val('holders', 'holderCount', 'holder_count'); return holders == null || Number(t.minHolders) <= 0 || holders >= Number(t.minHolders); }
}
module.exports = { DexWatcher };
