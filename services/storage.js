const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('../utils/crypto');

const file = path.join(process.cwd(), 'data', 'users.enc');
function readUsers(key) {
  try { return JSON.parse(decrypt(fs.readFileSync(file, 'utf8'), key)); } catch { return {}; }
}
function writeUsers(users, key) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, encrypt(JSON.stringify(users), key), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function getUser(id, key) { return readUsers(key)[String(id)] || { settings: { slippageBps: 100 } }; }
function saveUser(id, user, key) { const users = readUsers(key); users[String(id)] = user; writeUsers(users, key); }
function saveUserSecret(id, secret, key) { const user = getUser(id, key); user.encryptedSecret = encrypt(secret, key); saveUser(id, user, key); }
function getUserSecret(id, key) { const user = getUser(id, key); return user.encryptedSecret ? decrypt(user.encryptedSecret, key) : null; }
module.exports = { getUser, saveUser, saveUserSecret, getUserSecret };
