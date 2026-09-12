const axios = require('axios');
const { Connection, Keypair, PublicKey, VersionedTransaction, SystemProgram, Transaction } = require('@solana/web3.js');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const connection = (rpcUrl) => new Connection(rpcUrl, 'confirmed');
let lastQuoteAt = 0;
let jupiterBackoffUntil = 0;
let quoteQueue = Promise.resolve();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function enqueueQuote(task) {
  const next = quoteQueue.then(task, task);
  quoteQueue = next.catch(() => {});
  return next;
}

function validateSecretBytes(value) {
  if (!Array.isArray(value) || value.length !== 64 || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('يجب أن يكون MASTER_WALLET_PRIVATE_KEY مصفوفة JSON من 64 رقماً بين 0 و255.');
  }
  return Uint8Array.from(value);
}

function keypairFromSecret(secret) {
  if (secret instanceof Uint8Array) return Keypair.fromSecretKey(validateSecretBytes(Array.from(secret)));
  const raw = String(secret ?? '').trim();
  if (!raw) throw new Error('قيمة MASTER_WALLET_PRIVATE_KEY فارغة.');
  if (raw.startsWith('[')) {
    try { return Keypair.fromSecretKey(validateSecretBytes(JSON.parse(raw))); } catch (error) {
      if (error.message.startsWith('يجب')) throw error;
      throw new Error('صيغة MASTER_WALLET_PRIVATE_KEY غير صالحة. استخدم مصفوفة JSON من 64 رقماً.');
    }
  }
  try {
    const decoded = bs58.decode(raw);
    if (decoded.length !== 64) throw new Error('length');
    return Keypair.fromSecretKey(decoded);
  } catch {
    throw new Error('صيغة MASTER_WALLET_PRIVATE_KEY غير صالحة. استخدم Base58 صحيحاً أو مصفوفة JSON من 64 رقماً.');
  }
}

async function getQuote({ jupiterUrl, inputMint = SOL_MINT, outputMint, amountLamports, slippageBps = 100 }) {
  return enqueueQuote(async () => {
   try {
    if (!inputMint || !outputMint || !PublicKey.isOnCurve(new PublicKey(outputMint).toBytes())) throw new Error('عنوان العملة غير صالح.');
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const minInterval = Math.max(350, Number(process.env.JUPITER_MIN_INTERVAL_MS || 500));
      const wait = Math.max(0, minInterval - (Date.now() - lastQuoteAt), jupiterBackoffUntil - Date.now());
      if (wait) await sleep(wait);
      try {
        lastQuoteAt = Date.now();
        const { data } = await axios.get(`${jupiterUrl}/quote`, { params: { inputMint, outputMint, amount: amountLamports, slippageBps, swapMode: 'ExactIn' }, timeout: 8000 });
        return data;
      } catch (error) {
        lastError = error;
        if (error.response?.status !== 429 || attempt === 2) break;
        const retryAfter = Number(error.response.headers?.['retry-after'] || 0);
        const backoff = Math.min(15000, Math.max(2000, retryAfter * 1000 || (attempt + 1) * 2500));
        jupiterBackoffUntil = Date.now() + backoff;
        await sleep(backoff);
      }
    }
    throw lastError;
   } catch (error) {
    if (error.message === 'عنوان العملة غير صالح.') throw error;
    const detail = error.response?.data?.error || error.message;
    if (String(detail).toLowerCase().includes('no routes found')) throw new Error('لا يوجد مسار تداول لهذه العملة حالياً؛ قد تكون جديدة جداً أو بلا سيولة في Jupiter.');
    if (error.response?.status === 429) throw new Error('Jupiter مشغول حالياً بسبب كثرة الطلبات؛ أعد المحاولة بعد قليل.');
    throw new Error(`تعذر الحصول على سعر العملة: ${detail}`);
   }
  });
}

async function getTokenAmount({ rpcUrl, ownerSecret, mint, uiAmount }) {
  const wallet = keypairFromSecret(ownerSecret);
  try {
    const accounts = await connection(rpcUrl).getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
    const account = accounts.value.find(({ account }) => Number(account.data.parsed.info.tokenAmount.uiAmount || 0) >= uiAmount);
    if (!account) throw new Error('الرصيد غير كافٍ لهذه العملة.');
    const info = account.account.data.parsed.info.tokenAmount;
    return { raw: Math.round(uiAmount * (10 ** info.decimals)), decimals: info.decimals };
  } catch (error) {
    if (error.message === 'الرصيد غير كافٍ لهذه العملة.') throw error;
    throw new Error(`تعذر قراءة رصيد العملة: ${error.message}`);
  }
}

async function getTokenBalance({ rpcUrl, ownerSecret, mint, fraction = 1 }) {
  const wallet = keypairFromSecret(ownerSecret);
  try {
    const accounts = await connection(rpcUrl).getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
    const account = accounts.value.find(({ account }) => Number(account.data.parsed.info.tokenAmount.uiAmount || 0) > 0);
    if (!account) throw new Error('لا يوجد رصيد لهذه العملة.');
    const info = account.account.data.parsed.info.tokenAmount;
    return { raw: Math.floor(Number(info.amount) * fraction), decimals: info.decimals };
  } catch (error) {
    if (error.message === 'لا يوجد رصيد لهذه العملة.') throw error;
    throw new Error(`تعذر قراءة رصيد العملة: ${error.message}`);
  }
}

async function executeSwap({ rpcUrl, jupiterUrl, secret, quote, liveTrading, priorityFeeMaxLamports = 500000 }) {
  const wallet = keypairFromSecret(secret);
  if (!liveTrading) return { simulated: true, wallet: wallet.publicKey.toBase58(), message: 'الوضع التجريبي: لم تُرسل أي معاملة.' };
  try {
    const { data } = await axios.post(`${jupiterUrl}/swap`, { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { priorityLevel: 'veryHigh', maxLamports: priorityFeeMaxLamports } } }, { timeout: 15000 });
    const transaction = VersionedTransaction.deserialize(Buffer.from(data.swapTransaction, 'base64'));
    transaction.sign([wallet]);
    const conn = connection(rpcUrl);
    const signature = await conn.sendRawTransaction(transaction.serialize(), { maxRetries: 3, skipPreflight: false });
    await conn.confirmTransaction(signature, 'confirmed');
    const confirmed = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1 });
    const feeLamports = Number(confirmed?.meta?.fee || 0);
    return { simulated: false, signature, wallet: wallet.publicKey.toBase58(), feeLamports, feeSol: feeLamports / 1e9 };
  } catch (error) {
    throw new Error(`فشل إرسال المعاملة: ${error.response?.data?.error || error.message}`);
  }
}

async function getSolBalance({ rpcUrl, owner }) {
  const publicKey = owner instanceof PublicKey ? owner : new PublicKey(owner);
  return (await connection(rpcUrl).getBalance(publicKey, 'confirmed')) / 1e9;
}

async function checkSolReceived({ rpcUrl, signature, beforeSol, owner }) {
  const conn = connection(rpcUrl);
  const tx = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1 });
  if (!tx) throw new Error('لم يتم تأكيد المعاملة.');
  if (tx.meta?.err) throw new Error(`فشلت المعاملة على السلسلة: ${JSON.stringify(tx.meta.err)}`);
  const afterSol = await getSolBalance({ rpcUrl, owner });
  const received = afterSol - Number(beforeSol);
  if (!Number.isFinite(received) || received <= 0) throw new Error('لم يتم رصد SOL مستلم بعد البيع.');
  return received;
}

async function sendSol({ rpcUrl, secret, destination, amountSol, liveTrading, priorityFeeLamports = 0 }) {
  const wallet = keypairFromSecret(secret);
  const recipient = new PublicKey(destination);
  const lamports = Math.floor(Number(amountSol) * 1e9);
  if (!Number.isFinite(lamports) || lamports <= 0) throw new Error('مبلغ السحب يجب أن يكون أكبر من صفر.');
  if (!liveTrading) return { simulated: true, wallet: wallet.publicKey.toBase58(), destination: recipient.toBase58(), amountSol: lamports / 1e9 };
  const conn = connection(rpcUrl);
  const balance = await conn.getBalance(wallet.publicKey, 'confirmed');
  if (lamports >= balance) throw new Error('المبلغ يتجاوز الرصيد المتاح بعد احتساب رسوم الشبكة.');
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports }));
  const signature = await conn.sendTransaction(tx, [wallet], { maxRetries: 3, skipPreflight: false });
  await conn.confirmTransaction(signature, 'confirmed');
  return { simulated: false, signature, wallet: wallet.publicKey.toBase58(), destination: recipient.toBase58(), amountSol: lamports / 1e9 };
}

async function getPortfolio({ rpcUrl, secret }) {
  const wallet = keypairFromSecret(secret);
  try {
    const conn = connection(rpcUrl);
    const balance = await conn.getBalance(wallet.publicKey);
    const tokens = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID });
    return { address: wallet.publicKey.toBase58(), sol: balance / 1e9, tokens: tokens.value.map(({ account }) => account.data.parsed.info.tokenAmount).filter((x) => Number(x.uiAmount) > 0) };
  } catch (error) {
    throw new Error(`تعذر الاتصال بشبكة Solana: ${error.message}`);
  }
}

module.exports = { SOL_MINT, keypairFromSecret, getQuote, getTokenAmount, getTokenBalance, executeSwap, getSolBalance, sendSol, checkSolReceived, getPortfolio };
