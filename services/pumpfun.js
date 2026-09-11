const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const { HeliusService } = require('./helius');

const DEFAULT_URLS = ['https://frontend-api-v3.pump.fun/coins', 'https://frontend-api.pump.fun/coins'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class PumpFunWatcher {
  constructor({ adminId, settings, onCandidate, onError, onFilter }) {
    this.adminId = adminId;
    this.settings = settings;
    this.onCandidate = onCandidate;
    this.onError = onError;
    this.onFilter = onFilter || (() => {});
    this.running = false;
    this.seen = new Set();
    this.watchlist = new Map();
    this.watchTimer = null;
    this.watchlistBusy = false;
    this.lastPollAt = null;
    this.lastCandidate = null;
    this.lastError = null;
    this.source = process.env.PUMPFUN_API_URL || DEFAULT_URLS[0];
    this.heliusFailures = 0;
    this.helius = new HeliusService({
      apiKey: process.env.HELIUS_API_KEY,
      rpcUrl: process.env.HELIUS_RPC_URL,
      wsUrl: process.env.HELIUS_WS_URL,
      onMint: (event) => this.handleHeliusMint(event),
      onError: (error) => this.handleHeliusError(error),
    });
    this.streamMode = false;
  }

  updateSettings(settings) {
    this.settings = settings;
  }

  // ══════════════════════════════════════════════════════════════
  // Helius error handling with auto-fallback to REST polling
  // ══════════════════════════════════════════════════════════════
  handleHeliusError(error) {
    this.lastError = `Helius: ${error.message}`;
    this.onError(error);
    this.heliusFailures = (this.heliusFailures || 0) + 1;
    if (this.running && this.streamMode && error.code === 'HELIUS_CONNECT_TIMEOUT') {
      this.streamMode = false;
      this.heliusFailures = 0;
      try { this.helius.stop(); } catch (_) {}
      this.loop();
      return;
    }
    if (this.running && this.streamMode && this.heliusFailures >= 3) {
      console.log('[helius] Too many failures — falling back to REST polling');
      this.streamMode = false;
      this.heliusFailures = 0;
      try { this.helius.stop(); } catch (_) {}
      this.loop();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.streamMode = this.helius.start();
    const interval = Math.max(3000, Number(process.env.WATCHLIST_POLL_MS || 5000));
    this.watchTimer = setInterval(() => this.recheckWatchlist(), interval);
    console.log(`Pump.fun watchlist polling every ${interval}ms`);
    if (!this.streamMode) this.loop();
    else console.log('Helius Pump.fun WebSocket stream started');
  }

  stop() {
    this.running = false;
    this.helius.stop();
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.watchlist.clear();
  }

  resetCycle() {
    this.seen.clear();
    this.watchlist.clear();
    this.lastPollAt = null;
    this.lastCandidate = null;
    this.lastError = null;
    this.watchlistBusy = false;
    console.log('[cycle] Pump.fun scan history and watchlist reset');
  }

  status() {
    return {
      running: this.running,
      streamMode: this.streamMode,
      watchlistSize: this.watchlist.size,
      lastPollAt: this.lastPollAt,
      lastCandidate: this.lastCandidate,
      lastError: this.lastError,
      source: this.streamMode ? 'Helius WebSocket + DAS' : this.source,
    };
  }

  async fetchCoin(mint) {
    const urls = process.env.PUMPFUN_API_URL ? [process.env.PUMPFUN_API_URL] : DEFAULT_URLS;
    for (const base of urls) {
      const root = base.replace(/\/$/, '');
      try {
        const { data } = await axios.get(`${root}/${mint}`, { timeout: 8000 });
        if (data && (data.mint || data.address)) return data;
      } catch (_) {}
      try {
        const { data } = await axios.get(root, {
          params: { offset: 0, limit: 100, sort: 'created_timestamp', order: 'DESC', includeNsfw: false },
          timeout: 8000,
        });
        const coins = Array.isArray(data) ? data : (data.coins || data.data || []);
        const match = coins.find((coin) => String(coin.mint || coin.address) === String(mint));
        if (match) return match;
      } catch (_) {}
    }
    return null;
  }

  async handleHeliusMint(event) {
    if (!this.running) return;
    const coin = await this.fetchCoin(event.mint);
    if (!coin) return;
    this.seen.add(event.mint);
    const candidate = this.normalize(coin);
    candidate.creator = event.creator || coin.creator;
    candidate.source = 'helius-websocket';
    try {
      Object.assign(candidate, await this.helius.enrichToken(candidate.mint, candidate.creator, candidate.bondingCurve));
    } catch (error) {
      this.lastError = `Helius DAS: ${error.message}`;
      return;
    }
    await this.evaluate(candidate);
  }

  async loop() {
    while (this.running && !this.streamMode) {
      try {
        this.lastPollAt = new Date().toISOString();
        const urls = process.env.PUMPFUN_API_URL ? [process.env.PUMPFUN_API_URL] : DEFAULT_URLS;
        let response;
        let lastError;
        for (const url of urls) {
          try {
            response = await axios.get(url, {
              params: { offset: 0, limit: 25, sort: 'created_timestamp', order: 'DESC', includeNsfw: false },
              timeout: 10000,
            });
            this.source = url;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!response) throw lastError;
        this.lastError = null;
        const data = response.data;
        const coins = Array.isArray(data) ? data : (data.coins || data.data || []);
        for (const coin of coins.reverse()) {
          const mint = coin.mint || coin.address;
          if (!mint || this.seen.has(mint)) continue;
          this.seen.add(mint);
          if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
          const c = this.normalize(coin);
          console.log(`[scan] ${c.symbol} curve=${c.bondingCurveProgress.toFixed(1)}% src=${c.bondingCurveProgressSource}`);
          await this.evaluate(c);
        }
      } catch (error) {
        this.lastError = error.message;
        this.onError(error);
      }
      await sleep(30000);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // normalize — حساب نسبة Bonding Curve بطبقات احتياطية متتالية
  // ══════════════════════════════════════════════════════════════
  normalize(coin) {
    let bondingCurveProgress = 0;
    let progressSource = 'unavailable';

    // ── الطبقة 1: الحقل الصريح (إن وُجد من مزود بديل) ──
    const explicitKey = ['bonding_curve_progress', 'bondingCurveProgress', 'bonding_curve_percent', 'progress']
      .find((key) => coin[key] !== undefined && coin[key] !== null);
    if (explicitKey) {
      const raw = Number(coin[explicitKey]);
      if (Number.isFinite(raw) && raw >= 0) {
        bondingCurveProgress = raw <= 1 ? raw * 100 : raw;
        progressSource = `explicit:${explicitKey}`;
      }
    }

    // ── الطبقة 2: الحساب من virtual_sol_reserves (الطريقة الفعلية) ──
    if (progressSource === 'unavailable') {
      const virtualLamports = Number(coin.virtual_sol_reserves ?? coin.virtualSolReserves ?? coin.virtual_sol ?? 0);
      if (Number.isFinite(virtualLamports) && virtualLamports > 0) {
        const virtualSol = virtualLamports / 1e9;
        const INITIAL_VIRTUAL = 30;
        const FINAL_VIRTUAL = 85;
        const range = FINAL_VIRTUAL - INITIAL_VIRTUAL;
        const pct = ((virtualSol - INITIAL_VIRTUAL) / range) * 100;
        bondingCurveProgress = Math.max(0, Math.min(100, pct));
        progressSource = 'calculated-from-reserves';
      }
    }

    // ── الطبقة 3: الاحتياطي الحقيقي كبديل ثانوي ──
    if (progressSource === 'unavailable') {
      const realLamports = Number(coin.sol_reserves ?? coin.real_sol_reserves ?? coin.realSolReserves ?? 0);
      if (Number.isFinite(realLamports) && realLamports > 0) {
        const realSol = realLamports / 1e9;
        const FINAL_REAL = 85;
        const pct = (realSol / FINAL_REAL) * 100;
        bondingCurveProgress = Math.max(0, Math.min(100, pct));
        progressSource = 'calculated-from-real-reserves';
      }
    }

    // ── الطبقة 4: علامة الاكتمال ──
    if (progressSource === 'unavailable') {
      if (coin.complete === true || coin.bonded === true || coin.raydium_pool) {
        bondingCurveProgress = 100;
        progressSource = 'complete-flag';
      }
    }

    // ── إن فشلت كل الطبقات ──
    if (progressSource === 'unavailable') {
      progressSource = 'fallback-zero';
    }

    const virtualSol = Number(coin.virtual_sol_reserves ?? coin.virtualSolReserves ?? 0);

    return {
      mint: coin.mint || coin.address,
      name: coin.name || '',
      symbol: coin.symbol || 'N/A',
      decimals: Number(coin.decimals ?? 6),
      marketCapUsd: (() => {
        const v = coin.market_cap ?? coin.usd_market_cap;
        return v == null ? null : Number(v);
      })(),
      liquiditySol: (() => {
        const v = coin.liquidity_sol ?? coin.sol_reserves;
        if (v != null) return Number(v);
        const virtual = Number(coin.virtual_sol_reserves ?? coin.virtualSolReserves ?? 0);
        return virtual > 0 ? virtual / 1e9 : null;
      })(),
      volumeUsd: (() => {
        const v = coin.volume ?? coin.volume_usd ?? coin.usd_volume;
        return v == null ? null : Number(v);
      })(),
      buyVolumeUsd: (() => {
        const v = coin.buy_volume ?? coin.buy_volume_usd;
        return v == null ? null : Number(v);
      })(),
      sellVolumeUsd: (() => {
        const v = coin.sell_volume ?? coin.sell_volume_usd;
        return v == null ? null : Number(v);
      })(),
      uniqueBuyers: (() => {
        const v = coin.unique_buyers ?? coin.buyers ?? coin.uniqueBuyers;
        return v == null ? null : Number(v);
      })(),
      uniqueSellers: (() => {
        const v = coin.unique_sellers ?? coin.sellers;
        return v == null ? null : Number(v);
      })(),
      previousCurveProgress: Number(coin.previous_curve_progress ?? 0) || null,
      creatorSold: coin.creator_sold ?? null,
      bondingCurveProgress,
      bondingCurveProgressSource: progressSource,
      virtualSolReserves: virtualSol,
      mintAuthority: coin.mint_authority ?? coin.mintAuthority ?? null,
      freezeAuthority: coin.freeze_authority ?? coin.freezeAuthority ?? null,
      creator: coin.creator || coin.creator_address || null,
      bondingCurve: coin.bonding_curve || coin.bondingCurve || null,
      socialLinks: [coin.twitter, coin.telegram, coin.website].filter(Boolean),
      createdAt: (() => {
        const timestamp = Number(coin.created_timestamp ?? coin.createdAt ?? 0);
        return timestamp > 1e12 ? timestamp / 1000 : timestamp || null;
      })(),
    };
  }

  filterReason(candidate) {
    try { new PublicKey(candidate.mint); } catch { return 'عنوان Mint غير صالح'; }

    const s = this.settings;

    if (!candidate.name) return 'اسم العملة فارغ';

    if (s.requireSocialLinks && !candidate.socialLinks?.length) {
      return 'رابط تواصل مفقود';
    }

    if (s.requireRenouncedAuthorities && (candidate.mintAuthority || candidate.freezeAuthority)) {
      return 'Mint/Freeze Authority غير معطلة';
    }

    if (s.maxCurveProgress > 0 || s.minCurveProgress > 0) {
      const hasRealCurveData = candidate.bondingCurveProgressSource !== 'unavailable' &&
                                candidate.bondingCurveProgressSource !== 'fallback-zero';
      if (hasRealCurveData) {
        const minCurve = Number(s.minCurveProgress ?? 0);
        const maxCurve = Number(s.maxCurveProgress ?? 0);
        const rounded = Math.round(candidate.bondingCurveProgress * 10) / 10;
        if (minCurve > 0 && rounded < minCurve) {
          return `Bonding Curve ${rounded.toFixed(1)}% أقل من ${minCurve}%`;
        }
        if (maxCurve > 0 && rounded > maxCurve) {
          return `Bonding Curve ${rounded.toFixed(1)}% أعلى من ${maxCurve}%`;
        }
      }
    }

    const minVol = Number(s.minVolumeUsd ?? 0);
    if (minVol > 0) {
      if (candidate.volumeUsd == null) {
        if (!s.allowZeroVolume) {
          return '📊 حجم غير معروف — رفض احترازي';
        }
        const minLiqForZero = Number(s.allowZeroVolumeMinLiq ?? 30);
        if (!Number.isFinite(candidate.liquiditySol) || candidate.liquiditySol < minLiqForZero) {
          return `📊 حجم غير معروف + سيولة ${candidate.liquiditySol?.toFixed(1) || '?'} < ${minLiqForZero}`;
        }
      } else if (candidate.volumeUsd < minVol) {
        return `📊 حجم $${candidate.volumeUsd.toFixed(0)} أقل من $${minVol}`;
      }
    }

    const minBuyers = Number(s.minUniqueBuyers ?? 0);
    if (minBuyers > 0) {
      if (candidate.uniqueBuyers == null) {
        return '👥 مشترون غير معروفين — بيانات مفقودة';
      }
      if (candidate.uniqueBuyers < minBuyers) {
        return `👥 مشترون ${candidate.uniqueBuyers} أقل من ${minBuyers}`;
      }
    }

    const maxDev = Number(s.maxCreatorHoldingsPct ?? 0);
    if (candidate.heliusVerified && maxDev > 0 && candidate.creatorHoldingsPct > maxDev) {
      return `حيازة المنشئ ${candidate.creatorHoldingsPct}% تتجاوز ${maxDev}%`;
    }

    const maxTop = Number(s.maxTopHoldersPct ?? 0);
    if (candidate.heliusVerified && maxTop > 0 && candidate.topHoldersPct > maxTop) {
      return `حيازة كبار الملاك ${candidate.topHoldersPct}% تتجاوز ${maxTop}%`;
    }

    if (s.requireBuyVolumeDominance) {
      if (candidate.buyVolumeUsd == null || candidate.sellVolumeUsd == null) {
        return '📊 بيانات الشراء/البيع غير معروفة';
      }
      if (candidate.buyVolumeUsd <= candidate.sellVolumeUsd) {
        return `📊 شراء $${candidate.buyVolumeUsd.toFixed(0)} ≤ بيع $${candidate.sellVolumeUsd.toFixed(0)}`;
      }
    }

    const minLiq = Number(s.minLiquiditySol ?? 0);
    if (minLiq > 0) {
      if (!Number.isFinite(candidate.liquiditySol) || candidate.liquiditySol <= 0) {
        return '💧 سيولة غير معروفة — رفض احترازي';
      }
      if (candidate.liquiditySol < minLiq) {
        return `💧 سيولة ${candidate.liquiditySol.toFixed(2)} SOL أقل من ${minLiq}`;
      }
    }

    const minMcap = Number(s.minMarketCapUsd ?? 0);
    const maxMcap = Number(s.maxMarketCapUsd ?? 0);
    if (minMcap > 0 || maxMcap > 0) {
      if (!Number.isFinite(candidate.marketCapUsd) || candidate.marketCapUsd <= 0) {
        return '🎯 قيمة سوقية غير معروفة — رفض احترازي';
      }
      if (minMcap > 0 && candidate.marketCapUsd < minMcap) {
        return `🎯 MC $${candidate.marketCapUsd.toFixed(0)} أقل من $${minMcap}`;
      }
      if (maxMcap > 0 && candidate.marketCapUsd > maxMcap) {
        return `🎯 MC $${candidate.marketCapUsd.toFixed(0)} أعلى من $${maxMcap}`;
      }
    }

    const ageSec = candidate.createdAt
      ? (Date.now() / 1000) - Number(candidate.createdAt)
      : 0;
    const minAge = Number(s.minTokenAgeSec ?? 0);
    const maxAge = Number(s.maxTokenAgeSec ?? 0);
    if (ageSec > 0) {
      if (minAge > 0 && ageSec < minAge) return `عمر ${ageSec.toFixed(0)}ث أقل من ${minAge}ث`;
      if (maxAge > 0 && ageSec > maxAge) return `عمر ${ageSec.toFixed(0)}ث أكبر من ${maxAge}ث`;
    }

    if (s.rugProtectionEnabled) {
      if (candidate.buyVolumeUsd > 0 && candidate.sellVolumeUsd > 0) {
        const total = candidate.buyVolumeUsd + candidate.sellVolumeUsd;
        const sellRatio = candidate.sellVolumeUsd / total;
        if (sellRatio > 0.70 && total > 100) {
          return `🚨 بيع كثيف: ${(sellRatio * 100).toFixed(0)}% من الحجم`;
        }
      }

      if (candidate.liquiditySol > 0 && candidate.liquiditySol < 20) {
        return `🚨 سيولة منخفضة: ${candidate.liquiditySol.toFixed(1)} SOL`;
      }

      if (candidate.uniqueBuyers > 0 && candidate.uniqueSellers > 0 && candidate.uniqueSellers > candidate.uniqueBuyers * 2) {
        return `🚨 بائعون (${candidate.uniqueSellers}) أكثر من مشترين (${candidate.uniqueBuyers})`;
      }

      if (candidate.previousCurveProgress != null && candidate.bondingCurveProgress != null) {
        const drop = candidate.previousCurveProgress - candidate.bondingCurveProgress;
        if (drop >= 15) {
          return `🚨 هبوط المنحنى ${drop.toFixed(1)}% — dump محتمل`;
        }
      }

      if (candidate.heliusVerified && candidate.creatorSold === true) {
        return '🚨 المطور باع حصته';
      }
    }

    return null;
  }

  async evaluate(candidate) {
    const reason = this.filterReason(candidate);
    if (!reason) {
      this.watchlist.delete(candidate.mint);
      this.lastCandidate = candidate;
      console.log(`[candidate] ${candidate.symbol} ${candidate.mint} passed filters; launching trade`);
      await this.onCandidate(candidate);
      return true;
    }
    const minutes = Number(this.settings.watchlistMinutes || 0);
    if (minutes > 0 && reason !== 'عنوان Mint غير صالح') {
      const current = this.watchlist.get(candidate.mint) || {
        createdAt: Date.now(),
        expiresAt: Date.now() + minutes * 60000,
      };
      if (Date.now() < current.expiresAt) {
        this.watchlist.set(candidate.mint, { ...current, lastReason: reason });
        this.onFilter(candidate, `${reason} — قيد المراقبة`);
        return false;
      }
      this.watchlist.delete(candidate.mint);
    }
    this.onFilter(candidate, reason);
    return false;
  }

  // ══════════════════════════════════════════════════════════════
  // recheckWatchlist — مع إعادة تشغيل تلقائي للمؤقت إذا مات
  // ══════════════════════════════════════════════════════════════
  async recheckWatchlist() {
    // حماية: أعد إنشاء المؤقت إذا مات بشكل غير متوقع
    if (!this.watchTimer && this.running) {
      const interval = Math.max(3000, Number(process.env.WATCHLIST_POLL_MS || 5000));
      this.watchTimer = setInterval(() => this.recheckWatchlist(), interval);
      console.log(`[watchlist] Timer restarted (${interval}ms)`);
    }

    if (!this.running || !this.watchlist.size || this.watchlistBusy) return;
    this.watchlistBusy = true;

    try {
      for (const [mint, entry] of this.watchlist) {
        if (Date.now() >= entry.expiresAt) {
          this.watchlist.delete(mint);
          continue;
        }
        try {
          const coin = await this.fetchCoin(mint);
          if (!coin) {
            console.log(`[watchlist] ${mint}: لا توجد بيانات محدثة`);
            continue;
          }
          const candidate = this.normalize(coin);
          candidate.source = this.streamMode ? 'helius-watchlist' : 'pumpfun-watchlist';
          if (this.streamMode) {
            const enrichment = this.helius.enrichToken(mint, candidate.creator, candidate.bondingCurve);
            const timeout = new Promise((resolve) => setTimeout(() => resolve({}), 500));
            Object.assign(candidate, await Promise.race([enrichment, timeout]).catch(() => ({})));
          }
          const reason = this.filterReason(candidate);
          const volumeText = Number.isFinite(candidate.volumeUsd) ? `$${candidate.volumeUsd.toFixed(2)}` : 'unknown';
          console.log(`[watchlist] ${candidate.symbol} ${mint} | curve=${candidate.bondingCurveProgress.toFixed(2)}% (${candidate.bondingCurveProgressSource}) | volume=${volumeText} | buyers=${candidate.uniqueBuyers ?? 'unknown'} | result=${reason || 'PASS'}`);
          await this.evaluate(candidate);
        } catch (error) {
          this.lastError = `إعادة فحص: ${error.message}`;
          console.error(`[watchlist] ${mint}: ${this.lastError}`);
        }
      }
    } finally {
      this.watchlistBusy = false;
    }
  }

  matches(candidate) {
    const reason = this.filterReason(candidate);
    if (reason) {
      this.onFilter(candidate, reason);
      return false;
    }
    return true;
  }
}

module.exports = { PumpFunWatcher };
