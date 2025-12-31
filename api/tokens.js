// One-time encoded token flow
// Admin creates a secret (GitHub PAT) and then generates one-time codes that members can redeem.
// Storage in Upstash:
// - SET gh_secret:<sid> => JSON { secretId, owner, token (raw), createdAt }
// - SET gh_code:<cid> => JSON { codeId, secretId, status: 'unused'|'used', createdAt }
// - LIST gh_codes contains code ids (LRANGE)
// - LIST gh_secrets contains secret ids (optional)

const crypto = require('crypto');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function upstashCall(url, token, cmd, ...args) {
  const r = await fetch(url, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify([cmd, ...args]) });
  const j = await r.json();
  return j.result;
}

async function ghFetch(url, method, token, body) {
  try {
    const opts = { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'CodeCloud-VPS/1.0' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const text = await res.text();
    try { return { status: res.status, data: text ? JSON.parse(text) : {} }; } catch { return { status: res.status, data: { raw: text } }; }
  } catch (e) { return { status: 0, error: e.message }; }
}

function makeId(len = 20) { return crypto.randomBytes(len).toString('hex'); }

function maskOwner(owner) { if (!owner) return ''; return owner; }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return res.status(500).json({ success: false, message: 'Upstash not configured' });

  const body = req.body || {};
  const action = body.action;

  try {
    // Admin creates a secret + an initial one-time code
    if (action === 'create_code') {
      const pat = (body.token || '').trim();
      if (!pat || pat.length < 10) return res.status(400).json({ success: false, message: 'Missing token' });

      // validate token by getting user
      const me = await ghFetch('https://api.github.com/user', 'GET', pat);
      if (me.status !== 200 || !me.data.login) return res.status(401).json({ success: false, message: 'Token invalid or unauthorized', detail: me.data });
      const owner = me.data.login;

      const secretId = makeId(12);
      const secretKey = `gh_secret:${secretId}`;
      await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'SET', secretKey, JSON.stringify({ secretId, owner, token: pat, createdAt: new Date().toISOString() }));

      // create one-time code
      const codeId = makeId(10);
      const codeKey = `gh_code:${codeId}`;
      await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'SET', codeKey, JSON.stringify({ codeId, secretId, status: 'unused', createdAt: new Date().toISOString() }));
      await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'RPUSH', 'gh_codes', codeId);

      const code = `vmmc_${codeId}`;
      return res.json({ success: true, code: code, secretId, owner });
    }

    // Admin: create a fresh one-time code for existing secret
    if (action === 'new_code_for_secret') {
      const sid = body.secretId;
      if (!sid) return res.status(400).json({ success: false, message: 'Missing secretId' });
      const secretRaw = await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'GET', `gh_secret:${sid}`);
      if (!secretRaw) return res.status(404).json({ success: false, message: 'Secret not found' });
      const codeId = makeId(10);
      await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'SET', `gh_code:${codeId}`, JSON.stringify({ codeId, secretId: sid, status: 'unused', createdAt: new Date().toISOString() }));
      await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'RPUSH', 'gh_codes', codeId);
      return res.json({ success: true, code: `vmmc_${codeId}` });
    }

    // Admin: list codes (and secret info)
    if (action === 'list') {
      const ids = await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'LRANGE', 'gh_codes', '0', '-1') || [];
      const out = [];
      for (const cid of ids) {
        const cr = await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'GET', `gh_code:${cid}`);
        if (!cr) continue;
        try {
          const parsed = JSON.parse(cr);
          const secretRaw = await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'GET', `gh_secret:${parsed.secretId}`);
          let owner = '';
          if (secretRaw) { try { const s = JSON.parse(secretRaw); owner = s.owner; } catch(e){} }
          out.push({ code: `vmmc_${parsed.codeId}`, codeId: parsed.codeId, secretId: parsed.secretId, status: parsed.status, owner, createdAt: parsed.createdAt });
        } catch(e) { continue; }
      }
      return res.json({ success: true, items: out });
    }

    // Consume a code (member redeems it)
    if (action === 'consume') {
      const code = (body.code || '').trim();
      if (!code || !code.startsWith('vmmc_')) return res.status(400).json({ success: false, message: 'Invalid code' });
      const codeId = code.slice(5);
      const key = `gh_code:${codeId}`;
      const raw = await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'GET', key);
      if (!raw) return res.status(404).json({ success: false, message: 'Code not found or expired' });
      const parsed = JSON.parse(raw);
      if (parsed.status && parsed.status === 'used') return res.json({ success: false, message: 'Code already used or expired' });

      // fetch secret
      const secretRaw = await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'GET', `gh_secret:${parsed.secretId}`);
      if (!secretRaw) return res.status(500).json({ success: false, message: 'Secret missing' });
      const secret = JSON.parse(secretRaw);

      // mark code used
      parsed.status = 'used';
      parsed.usedAt = new Date().toISOString();
      await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'SET', key, JSON.stringify(parsed));

      return res.json({ success: true, token: secret.token, owner: secret.owner });
    }

    // Admin: delete code
    if (action === 'delete') {
      const cid = body.codeId;
      if (!cid) return res.status(400).json({ success: false, message: 'Missing codeId' });
      await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'DEL', `gh_code:${cid}`);
      await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'LREM', 'gh_codes', '0', cid);
      return res.json({ success: true });
    }

    return res.status(400).json({ success: false, message: 'Unknown action' });
  } catch (err) {
    console.error('[tokens] error', err);
    return res.status(500).json({ success: false, message: String(err) });
  }
};
