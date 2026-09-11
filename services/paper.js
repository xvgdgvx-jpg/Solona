const axios = require('axios');
const { getQuote, getTokenBalance, executeSwap, checkSolReceived, SOL_MINT, keypairFromSecret } = require('./solana');
const { getUser, saveUser } = require('./storage');

const getPositions = (adminId, key) => getUser(adminId, key).paperPositions || [];
let _positionsLock = Promise.resolve();
function withPositionsLock(fn) {
  const previous = _positionsLock;
  let release;
  _positionsLock = new Promise((resolve) => { release = resolve; });
  return previous.then(fn).finally(() => release());
}
function savePositionsUnlocked(adminId, positions, key) {
  const user = getUser(adminId, key);
  const existing = user.paperPositions || [];
  const merged = existing.map((old) => positions.find((p) => p.id === old.id) || old);
  for (const position of positions) {
    if (!merged.find((item) => item.id === position.id)) merged.push(position);
  }
  saveUser(adminId, { ...user, paperPositions: merged }, key);
}
function savePositions(adminId, positions, key) {
  return withPositionsLock(() => savePositionsUnlocked(adminId, positions, key));
}
let priceCache = { data: null, timestamp: 0 };
const PRICE_CACHE_MS = 50;

let solUsdCache = { value: null, timestamp: 0, inFlight: null };
const SOL_USD_CACHE_MS = 60000;
const SOL_USD_STALE_MS = 300000;

async function solUsd() {
  const now = Date.now();
  if (solUsdCache.value !== null && now - solUsdCache.timestamp < SOL_USD_CACHE_MS) return solUsdCache.value;
  if (solUsdCache.inFlight) return solUsdCache.inFlight;

  solUsdCache.inFlight = (async () => {
    try {
      const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price', { params: { ids: 'solana', vs_currencies: 'usd' }, timeout: 5000 });
      const value = Number(data?.solana?.usd);
      if (Number.isFinite(value) && value > 0) {
        solUsdCache.value = value;
        solUsdCache.timestamp = Date.now();
        return value;
      }
      return solUsdCache.value;
    } catch (error) {
      const code = error.response?.status;
      if (code === 429) {
        if (solUsdCache.value !== null) return solUsdCache.value;
      } else {
        console.warn(`[solUsd] error: ${error.message}`);
      }
      return solUsdCache.value;
    } finally {
      solUsdCache.inFlight = null;
    }
  })();

  return solUsdCache.inFlight;
}

async function openPosition({ adminId, key, jupiterUrl, mint, investedSol, quote, metadata = {}, mode = 'paper', buySignature = null }) {
  return withPositionsLock(async () => {
  const positions = getPositions(adminId, key);
  const outAmount = Number(quote.outAmount);
  if (!Number.isFinite(outAmount) || outAmount <= 0) throw new Error('لم يُرجع مصدر التسعير كمية صالحة.');
  const decimals = Number(metadata.decimals ?? 6);
  const tokenAmount = outAmount / (10 ** decimals);
  const existing = positions.find((p) => p.mint === mint && p.status === 'open');
  if (existing) {
    existing.investedSol += investedSol;
    existing.tokenAmountRaw += outAmount;
    existing.tokenAmount = existing.tokenAmountRaw / (10 ** existing.decimals);
    existing.entryPriceSol = existing.investedSol / existing.tokenAmount;
    existing.updatedAt = Date.now();
    existing.mode = existing.mode || mode;
    if (buySignature) existing.buySignature = buySignature;
    existing.entryMetadata = { ...(existing.entryMetadata || {}), ...metadata };
  } else {
    positions.push({
      id: `${mint}:${Date.now()}`,
      mint,
      name: metadata.name || 'بدون اسم',
      symbol: metadata.symbol || 'N/A',
      mode,
      investedSol,
      tokenAmountRaw: outAmount,
      tokenAmount,
      decimals,
      entryPriceSol: investedSol / tokenAmount,
      entryQuote: quote,
      buySignature,
      sellSignatures: [],
      tp1Sold: false,
      highestPnlPct: null,
      openedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'open',
      capitalProtectionTriggered: false,
      consecutivePricingErrors: 0,
      lastPricingAt: null,
      entryMetadata: { ...metadata },
      liquiditySol: Number(metadata.liquiditySol || 0),
      marketCapUsd: Number(metadata.marketCapUsd || 0),
    });
  }
  savePositionsUnlocked(adminId, positions, key);
  return positions.find((p) => p.mint === mint && p.status === 'open');
  });
}

async function refreshSinglePosition({ jupiterUrl, position }) {
  try {
    const quote = await getQuote({ jupiterUrl, inputMint: position.mint, outputMint: SOL_MINT, amountLamports: position.tokenAmountRaw, slippageBps: 100 });
    const currentSol = Number(quote.outAmount) / 1e9;
    return { ...position, currentSol, pnlSol: currentSol - position.investedSol, pnlPct: position.investedSol ? ((currentSol / position.investedSol) - 1) * 100 : 0, quote, pricingError: null };
  } catch (error) {
    return { ...position, currentSol: null, pnlSol: null, pnlPct: null, quote: null, pricingError: error.message };
  }
}

async function refreshPositions({ adminId, key, jupiterUrl }) {
  const positions = getPositions(adminId, key).filter((p) => p.status === 'open');
  const values = await Promise.all(positions.map((position) => refreshSinglePosition({ jupiterUrl, position })));
  let highestChanged = false;
  for (const value of values) {
    if (!Number.isFinite(value.pnlPct)) continue;
    const position = positions.find((p) => p.id === value.id);
    if (position && value.pnlPct > Number(position.highestPnlPct ?? -Infinity)) {
      position.highestPnlPct = value.pnlPct;
      position.consecutivePricingErrors = 0;
      position.lastPricingAt = Date.now();
      position.updatedAt = Date.now();
      highestChanged = true;
    }
  }
  if (highestChanged) await savePositions(adminId, positions, key);
  const usd = await solUsd();
  return { values, solUsd: usd };
}

async function refreshPositionsCached(params) {
  const now = Date.now();
  if (priceCache.data && now - priceCache.timestamp < PRICE_CACHE_MS) return priceCache.data;
  const result = await refreshPositions(params);
  priceCache = { data: result, timestamp: now };
  return result;
}

async function closePosition({ adminId, key, positionId, fraction = 1, jupiterUrl, rpcUrl, ownerSecret }) {
  return withPositionsLock(async () => {
  const positions = getPositions(adminId, key);
  const position = positions.find((p) => p.id === positionId && p.status === 'open');
  if (!position) return null;
  position.status = 'closing';
  position.updatedAt = Date.now();
  savePositionsUnlocked(adminId, positions, key);
  try {
    if (position.mode === 'live') {
      if (!rpcUrl || !ownerSecret) throw new Error('إعدادات RPC أو المحفظة غير متوفرة لإغلاق المركز الحي.');
      const wallet = keypairFromSecret(ownerSecret);
      const balance = await getTokenBalance({ rpcUrl, ownerSecret, mint: position.mint });
      const requested = Math.floor(position.tokenAmountRaw * fraction);
      if (balance.raw < requested) throw new Error('الرصيد الفعلي أقل من الكمية المطلوبة.');
      const amountToSell = Math.floor(balance.raw * fraction);
      const beforeSol = await getSolBalance({ rpcUrl, owner: wallet.publicKey.toBase58() });
      const quote = await getQuote({ jupiterUrl, inputMint: position.mint, outputMint: SOL_MINT, amountLamports: amountToSell, slippageBps: 100 });
      const swapResult = await executeSwap({ rpcUrl, jupiterUrl, secret: ownerSecret, quote, liveTrading: true });
      if (!swapResult.signature) throw new Error('لم تُرجع المعاملة توقيعاً.');
      const currentSol = await checkSolReceived({ rpcUrl, signature: swapResult.signature, beforeSol, owner: wallet.publicKey.toBase58() });
      const currentPositions = getPositions(adminId, key);
      const currentPosition = currentPositions.find((p) => p.id === positionId && p.status === 'closing');
      if (!currentPosition) throw new Error('تعذر العثور على المركز المحدّث بعد تنفيذ البيع.');
      const investedPart = currentPosition.investedSol * fraction;
      const pnlSol = currentSol - investedPart;
      const pnlPct = investedPart ? (pnlSol / investedPart) * 100 : 0;
      currentPosition.sellSignatures = [...(currentPosition.sellSignatures || []), swapResult.signature];
      currentPosition.lastPricingAt = Date.now();
      currentPosition.consecutivePricingErrors = 0;
      if (fraction >= 1) currentPosition.status = 'closed';
      else {
        currentPosition.tokenAmountRaw -= amountToSell;
        currentPosition.tokenAmount = currentPosition.tokenAmountRaw / (10 ** currentPosition.decimals);
        currentPosition.investedSol -= investedPart;
        currentPosition.tp1Sold = true;
        currentPosition.status = 'open';
      }
      currentPosition.updatedAt = Date.now();
      savePositionsUnlocked(adminId, currentPositions, key);
      return { currentSol, pnlSol, pnlPct, fraction, signature: swapResult.signature };
    }

    const value = await refreshSinglePosition({ jupiterUrl, position: { ...position, tokenAmountRaw: Math.floor(position.tokenAmountRaw * fraction), investedSol: position.investedSol * fraction } });
    if (value.pricingError) throw new Error(`لا يمكن محاكاة البيع الآن: ${value.pricingError}`);
    const currentPositions = getPositions(adminId, key);
    const currentPosition = currentPositions.find((p) => p.id === positionId && p.status === 'closing');
    if (!currentPosition) throw new Error('تعذر العثور على المركز المحدّث بعد تسعير البيع.');
    if (fraction >= 1) currentPosition.status = 'closed';
    else {
      const soldRaw = Math.floor(currentPosition.tokenAmountRaw * fraction);
      currentPosition.tokenAmountRaw -= soldRaw;
      currentPosition.tokenAmount = currentPosition.tokenAmountRaw / (10 ** currentPosition.decimals);
      currentPosition.investedSol -= currentPosition.investedSol * fraction;
      currentPosition.tp1Sold = true;
      currentPosition.status = 'open';
    }
    currentPosition.consecutivePricingErrors = 0;
    currentPosition.lastPricingAt = Date.now();
    currentPosition.updatedAt = Date.now();
    savePositionsUnlocked(adminId, currentPositions, key);
    return { ...value, fraction };
  } catch (error) {
    const currentPositions = getPositions(adminId, key);
    const currentPosition = currentPositions.find((p) => p.id === positionId && p.status === 'closing');
    if (currentPosition) {
      currentPosition.status = 'open';
      currentPosition.consecutivePricingErrors = (currentPosition.consecutivePricingErrors || 0) + 1;
      currentPosition.lastPricingAt = Date.now();
      currentPosition.updatedAt = Date.now();
      savePositionsUnlocked(adminId, currentPositions, key);
    }
    throw error;
  }
  });
}

function cleanupStaleClosing(adminId, key) {
  return withPositionsLock(() => {
    const positions = getPositions(adminId, key);
    const now = Date.now();
    let changed = false;
    for (const position of positions) {
      if (position.status === 'closing' && position.updatedAt && now - position.updatedAt > 5 * 60 * 1000) {
        console.log(`[cleanup] إعادة فتح مركز عالق: ${position.id}`);
        position.status = 'open';
        position.updatedAt = now;
        changed = true;
      }
    }
    if (changed) savePositionsUnlocked(adminId, positions, key);
  });
}

module.exports = { openPosition, refreshSinglePosition, refreshPositions, refreshPositionsCached, closePosition, getPositions, savePositions, cleanupStaleClosing };
