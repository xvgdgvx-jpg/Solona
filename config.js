require('dotenv').config();
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { Keypair } = require('@solana/web3.js');

const required = ['TELEGRAM_BOT_TOKEN', 'SOLANA_RPC_URL', 'ENCRYPTION_KEY', 'ADMIN_TELEGRAM_ID'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);

const mnemonic = process.env.PHANTOM_MNEMONIC || process.env.SOLANA_MNEMONIC || process.env.MASTER_WALLET_MNEMONIC;
let masterPrivateKey;
let walletSource;
if (mnemonic) {
  const normalizedMnemonic = mnemonic.trim().replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(normalizedMnemonic)) {
    throw new Error('عبارة الاسترداد غير صالحة. يجب استخدام 12 كلمة صحيحة (أو عبارة BIP39 صالحة) في متغير PHANTOM_MNEMONIC.');
  }
  try {
    const seed = bip39.mnemonicToSeedSync(normalizedMnemonic);
    const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
    masterPrivateKey = Keypair.fromSeed(derivedSeed).secretKey;
    walletSource = 'mnemonic';
    console.log("تم اشتقاق محفظة Solana من عبارة الاسترداد باستخدام المسار m/44'/501'/0'/0'.");
  } catch (error) {
    throw new Error(`تعذر اشتقاق محفظة Solana من عبارة الاسترداد: ${error.message}`);
  }
} else if (process.env.MASTER_WALLET_PRIVATE_KEY) {
  masterPrivateKey = process.env.MASTER_WALLET_PRIVATE_KEY;
  walletSource = 'private-key';
  console.warn('تحذير: يعمل البوت باستخدام MASTER_WALLET_PRIVATE_KEY. يُفضّل استخدام PHANTOM_MNEMONIC.');
} else {
  throw new Error('لم يتم العثور على عبارة الاسترداد. عيّن PHANTOM_MNEMONIC (أو SOLANA_MNEMONIC / MASTER_WALLET_MNEMONIC) في متغيرات البيئة.');
}

const encryptionKey = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
if (encryptionKey.length !== 32) throw new Error('ENCRYPTION_KEY must be a 64-character hexadecimal AES-256 key');
const configuredJupiterUrl = process.env.JUPITER_API_URL || '';
const jupiterUrl = configuredJupiterUrl.includes('quote-api.jup.ag') ? 'https://api.jup.ag/swap/v1' : (configuredJupiterUrl || 'https://api.jup.ag/swap/v1');

module.exports = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  rpcUrl: process.env.SOLANA_RPC_URL,
  encryptionKey,
  masterPrivateKey,
  walletSource,
  adminId: String(process.env.ADMIN_TELEGRAM_ID),
  liveTrading: String(process.env.LIVE_TRADING).toLowerCase() === 'true',
  jupiterUrl,
  port: Number(process.env.PORT || 3000),
  keepAliveUrl: process.env.KEEPALIVE_URL || `http://127.0.0.1:${process.env.PORT || 3000}/health`
};
