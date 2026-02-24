// api/admin.js
// ใช้ GitHub Gist เป็น database แทน KV

const { randomBytes } = require('crypto');

const GIST_ID    = process.env.GIST_ID;     // GitHub Gist ID
const GH_TOKEN   = process.env.GH_TOKEN;    // GitHub Personal Access Token
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ── GitHub Gist helpers ───────────────────────────────────
async function readDB() {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  const data = await res.json();
  try {
    const keys  = JSON.parse(data.files['keys.json']?.content  || '{}');
    const users = JSON.parse(data.files['users.json']?.content || '{}');
    return { keys, users };
  } catch {
    return { keys: {}, users: {} };
  }
}

async function writeDB(keys, users) {
  await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: {
        'keys.json':  { content: JSON.stringify(keys,  null, 2) },
        'users.json': { content: JSON.stringify(users, null, 2) },
      }
    }),
  });
}

// ── CORS ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ success: false, message: 'Method not allowed' });

  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const body = req.body;
  if (!body?.action) return res.status(400).json({ success: false, message: 'Missing action' });

  const { action } = body;

  try {
    const db = await readDB();
    const { keys, users } = db;

    // ── Generate Key ──────────────────────────────────────
    if (action === 'generate') {
      const { project = 'Yn', days = 7, uses = -1, cooldown = 60 } = body;
      const raw = randomBytes(16).toString('hex').toUpperCase();
      const key = `YN-${raw.slice(0,8)}-${raw.slice(8,16)}-${raw.slice(16,24)}`;
      keys[key] = {
        key, project,
        expires: new Date(Date.now() + days * 864e5).toISOString(),
        usesLeft: uses, cooldown,
        hwid: null, lastUsed: null,
        createdAt: new Date().toISOString(),
      };
      await writeDB(keys, users);
      return res.json({ success: true, key });
    }

    // ── Delete Key ────────────────────────────────────────
    if (action === 'delete') {
      const { key } = body;
      if (!keys[key]) return res.json({ success: false, message: 'Key not found' });
      delete keys[key];
      for (const [uid, k] of Object.entries(users)) {
        if (k === key) delete users[uid];
      }
      await writeDB(keys, users);
      return res.json({ success: true });
    }

    // ── Search Key ────────────────────────────────────────
    if (action === 'search') {
      const { key } = body;
      const doc = keys[key];
      if (!doc) return res.json({ success: false, message: 'Key not found' });
      return res.json({ success: true, doc });
    }

    // ── Renew Key ─────────────────────────────────────────
    if (action === 'renew') {
      const { key, days } = body;
      if (!keys[key]) return res.json({ success: false, message: 'Key not found' });
      keys[key].expires = new Date(new Date(keys[key].expires).getTime() + days * 864e5).toISOString();
      await writeDB(keys, users);
      return res.json({ success: true, newExpiry: keys[key].expires });
    }

    // ── Top-up Uses ───────────────────────────────────────
    if (action === 'topup') {
      const { key, uses } = body;
      if (!keys[key]) return res.json({ success: false, message: 'Key not found' });
      if (keys[key].usesLeft === -1) return res.json({ success: false, message: 'Key is unlimited' });
      keys[key].usesLeft += uses;
      await writeDB(keys, users);
      return res.json({ success: true, newUses: keys[key].usesLeft });
    }

    // ── Reset HWID ────────────────────────────────────────
    if (action === 'resethwid') {
      const { key } = body;
      if (!keys[key]) return res.json({ success: false, message: 'Key not found' });
      keys[key].hwid = null;
      await writeDB(keys, users);
      return res.json({ success: true });
    }

    // ── Count Keys ────────────────────────────────────────
    if (action === 'count') {
      return res.json({ success: true, count: Object.keys(keys).length });
    }

    // ── User Binding ──────────────────────────────────────
    if (action === 'getuser') {
      const { userId } = body;
      const key = users[userId] || null;
      return key ? res.json({ success: true, key }) : res.json({ success: false });
    }
    if (action === 'setuser') {
      const { userId, key } = body;
      users[userId] = key;
      await writeDB(keys, users);
      return res.json({ success: true });
    }
    if (action === 'removeuser') {
      const { userId } = body;
      delete users[userId];
      await writeDB(keys, users);
      return res.json({ success: true });
    }

    return res.status(400).json({ success: false, message: 'Unknown action' });

  } catch (err) {
    console.error('Admin Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
