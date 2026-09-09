require('dotenv').config();

const required = ['TELEGRAM_BOT_TOKEN', 'SOLANA_RPC_URL', 'ENCRYPTION_KEY', 'MASTER_WALLET_PRIVATE_KEY', 'ADMIN_TELEGRAM_ID'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);

const encryptionKey = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
if (encryptionKey.length !== 32) throw new Error('ENCRYPTION_KEY must be a 64-character hexadecimal AES-256 key');

module.exports = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  rpcUrl: process.env.SOLANA_RPC_URL,
  encryptionKey,
  masterPrivateKey: process.env.MASTER_WALLET_PRIVATE_KEY,
  adminId: String(process.env.ADMIN_TELEGRAM_ID),
  liveTrading: String(process.env.LIVE_TRADING).toLowerCase() === 'true',
  jupiterUrl: process.env.JUPITER_API_URL || 'https://quote-api.jup.ag/v6',
  port: Number(process.env.PORT || 3000),
  keepAliveUrl: process.env.KEEPALIVE_URL || `http://127.0.0.1:${process.env.PORT || 3000}/health`
};
