// api/auth.js — Vercel Serverless Function
// แทน Express /auth endpoint เดิม
// ใช้ Vercel KV (Redis) เก็บ Key แทน keys.json

import { kv } from '@vercel/kv';

export const config = { runtime: 'edge' };

// ── CORS Headers ──────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

// ── Main Handler ──────────────────────────────────────────
export default async function handler(req) {
  // Preflight
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, message: 'Method not allowed' }, 405);

  let body;
  try { body = await req.json(); }
  catch { return json({ success: false, message: 'Invalid JSON' }, 400); }

  const { key, hwid, userid, gameid } = body;
  if (!key || !hwid) return json({ success: false, message: 'Missing key or HWID' }, 400);

  // ── ดึง Key จาก KV ────────────────────────────────────
  const doc = await kv.hgetall(`key:${key}`);
  if (!doc) return json({ success: false, message: 'Invalid key' });

  // ตรวจหมดอายุ
  if (new Date(doc.expires) < new Date()) return json({ success: false, message: 'Key expired' });

  // ตรวจ Uses
  if (Number(doc.usesLeft) === 0) return json({ success: false, message: 'No uses left' });

  // ตรวจ HWID
  if (!doc.hwid) {
    await kv.hset(`key:${key}`, { hwid });
    doc.hwid = hwid;
  } else if (doc.hwid !== hwid) {
    return json({ success: false, message: 'HWID mismatch' });
  }

  // ตรวจ Cooldown
  if (doc.lastUsed) {
    const elapsed = Date.now() - new Date(doc.lastUsed).getTime();
    const cooldownMs = Number(doc.cooldown || 60) * 60000;
    if (elapsed < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
      return json({ success: false, message: `On cooldown. Wait ${remaining} minutes.` });
    }
  }

  // ── อัปเดต Key ────────────────────────────────────────
  const updates = { lastUsed: new Date().toISOString() };
  if (Number(doc.usesLeft) > 0) updates.usesLeft = Number(doc.usesLeft) - 1;
  await kv.hset(`key:${key}`, updates);

  // ── Discord Webhook ────────────────────────────────────
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

  return json({ success: true, message: 'Authenticated', project: doc.project });
}
