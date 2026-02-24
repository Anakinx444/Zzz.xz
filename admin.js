// api/admin.js — จัดการ Key (Generate / Delete / Search / Renew / Topup)
// Discord Bot จะเรียก endpoint นี้แทนการเขียน JSON ไฟล์

import { kv } from '@vercel/kv';
import { randomBytes } from 'crypto';

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

function checkSecret(req) {
  return req.headers.get('X-Admin-Secret') === process.env.ADMIN_SECRET;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, message: 'Method not allowed' }, 405);
  if (!checkSecret(req)) return json({ success: false, message: 'Unauthorized' }, 401);

  let body;
  try { body = await req.json(); }
  catch { return json({ success: false, message: 'Invalid JSON' }, 400); }

  const { action } = body;

  // ── Generate Key ──────────────────────────────────────
  if (action === 'generate') {
    const { project = 'Yn', days = 7, uses = -1, cooldown = 60 } = body;
    const raw = randomBytes(16).toString('hex').toUpperCase();
    const key = `YN-${raw.slice(0,8)}-${raw.slice(8,16)}-${raw.slice(16,24)}`;
    const doc = {
      key, project,
      expires: new Date(Date.now() + days * 864e5).toISOString(),
      usesLeft: uses,
      cooldown,
      hwid: '',
      lastUsed: '',
      createdAt: new Date().toISOString(),
    };
    await kv.hset(`key:${key}`, doc);
    await kv.sadd('keys', key);
    return json({ success: true, key, doc });
  }

  // ── Delete Key ────────────────────────────────────────
  if (action === 'delete') {
    const { key } = body;
    const exists = await kv.exists(`key:${key}`);
    if (!exists) return json({ success: false, message: 'Key not found' });
    await kv.del(`key:${key}`);
    await kv.srem('keys', key);
    // ลบ user binding ด้วย
    const userId = await kv.get(`user_key:${key}`);
    if (userId) {
      await kv.del(`user:${userId}`);
      await kv.del(`user_key:${key}`);
    }
    return json({ success: true });
  }

  // ── Search Key ────────────────────────────────────────
  if (action === 'search') {
    const { key } = body;
    const doc = await kv.hgetall(`key:${key}`);
    if (!doc) return json({ success: false, message: 'Key not found' });
    return json({ success: true, doc });
  }

  // ── Renew Key ─────────────────────────────────────────
  if (action === 'renew') {
    const { key, days } = body;
    const doc = await kv.hgetall(`key:${key}`);
    if (!doc) return json({ success: false, message: 'Key not found' });
    const newExpiry = new Date(new Date(doc.expires).getTime() + days * 864e5).toISOString();
    await kv.hset(`key:${key}`, { expires: newExpiry });
    return json({ success: true, newExpiry });
  }

  // ── Top-up Uses ───────────────────────────────────────
  if (action === 'topup') {
    const { key, uses } = body;
    const doc = await kv.hgetall(`key:${key}`);
    if (!doc) return json({ success: false, message: 'Key not found' });
    if (Number(doc.usesLeft) === -1) return json({ success: false, message: 'Key is unlimited' });
    const newUses = Number(doc.usesLeft) + uses;
    await kv.hset(`key:${key}`, { usesLeft: newUses });
    return json({ success: true, newUses });
  }

  // ── Reset HWID ────────────────────────────────────────
  if (action === 'resethwid') {
    const { key } = body;
    const doc = await kv.hgetall(`key:${key}`);
    if (!doc) return json({ success: false, message: 'Key not found' });
    await kv.hset(`key:${key}`, { hwid: '' });
    return json({ success: true });
  }

  // ── Count Keys ────────────────────────────────────────
  if (action === 'count') {
    const count = await kv.scard('keys');
    return json({ success: true, count });
  }

  return json({ success: false, message: 'Unknown action' }, 400);
}
