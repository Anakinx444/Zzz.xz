// api/auth.js — Node.js runtime

// ── KV REST helpers ───────────────────────────────────────
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvFetch(cmd, ...args) {
  const path = [cmd, ...args].map(a => encodeURIComponent(String(a))).join('/');
  const res = await fetch(`${KV_URL}/${path}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const data = await res.json();
  return data.result ?? null;
}

async function kvGet(key) {
  const r = await kvFetch('get', key);
  if (r === null) return null;
  try { return JSON.parse(r); } catch { return r; }
}
async function kvSet(key, value) {
  const v = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return kvFetch('set', key, v);
}

// ── Main Handler ──────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ success: false, message: 'Method not allowed' });

  const { key, hwid, userid, gameid } = req.body || {};
  if (!key || !hwid) return res.status(400).json({ success: false, message: 'Missing key or HWID' });

  try {
    const doc = await kvGet(`key:${key}`);
    if (!doc) return res.json({ success: false, message: 'Invalid key' });
    if (new Date(doc.expires) < new Date()) return res.json({ success: false, message: 'Key expired' });
    if (Number(doc.usesLeft) === 0) return res.json({ success: false, message: 'No uses left' });

    // ตรวจ HWID
    if (!doc.hwid) {
      doc.hwid = hwid;
    } else if (doc.hwid !== hwid) {
      return res.json({ success: false, message: 'HWID mismatch' });
    }

    // ตรวจ Cooldown
    if (doc.lastUsed) {
      const elapsed = Date.now() - new Date(doc.lastUsed).getTime();
      const cooldownMs = Number(doc.cooldown || 60) * 60000;
      if (elapsed < cooldownMs) {
        const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
        return res.json({ success: false, message: `On cooldown. Wait ${remaining} minutes.` });
      }
    }

    // อัปเดต Key
    if (Number(doc.usesLeft) > 0) doc.usesLeft = Number(doc.usesLeft) - 1;
    doc.lastUsed = new Date().toISOString();
    await kvSet(`key:${key}`, doc);

    // Discord Webhook
    const webhookUrl = process.env.WEBHOOK_URL;
    if (webhookUrl && !webhookUrl.includes('xxxxxxxx')) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: '✅ Key Used',
            description: `Key: **${key}**\nHWID: ${hwid}\nUserID: ${userid}\nGameID: ${gameid}`,
            color: 0x00ff00,
            timestamp: new Date().toISOString(),
          }]
        })
      }).catch(() => {});
    }

    return res.json({ success: true, message: 'Authenticated', project: doc.project });

  } catch (err) {
    console.error('Auth Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
