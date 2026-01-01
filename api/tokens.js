// Token management for GitHub PATs
// Stores tokens in Upstash Redis under keys:
// - list 'gh_tokens' contains token ids
// - key `gh_token:<id>` stores JSON { token, meta }

const TEST_WORKFLOW = `name: Token Check
on:
  workflow_dispatch:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Echo
        run: echo "ok"
`;

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

function maskTokenTok(tok) { if (!tok) return ''; return tok.slice(0, 6) + '...' + tok.slice(-4); }

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
    if (action === 'add') {
      const pat = (body.token || '').trim();
      if (!pat || pat.length < 10) return res.status(400).json({ success: false, message: 'Missing token' });

      // Validate token by fetching user
      const me = await ghFetch('https://api.github.com/user', 'GET', pat);
      if (me.status !== 200 || !me.data.login) return res.status(401).json({ success: false, message: 'Token invalid or unauthorized', detail: me.data });
      const owner = me.data.login;

      // store secret
      const id = String(Date.now());
      const key = `gh_token:${id}`;
      const obj = { id, owner, masked: maskTokenTok(pat), createdAt: new Date().toISOString(), lastChecked: new Date().toISOString(), status: 'live' };
      await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'SET', key, JSON.stringify({ token: pat, meta: obj }));
      await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'RPUSH', 'gh_tokens', id);

      return res.json({ success: true, token: obj });
    }

    if (action === 'list') {
      const ids = await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'LRANGE', 'gh_tokens', '0', '-1') || [];
      const out = [];
      for (const id of ids) {
        const raw = await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'GET', `gh_token:${id}`);
        if (!raw) continue;
        try { const parsed = JSON.parse(raw); const meta = parsed.meta || {}; out.push({ id: meta.id || id, owner: meta.owner, masked: meta.masked, status: meta.status, lastChecked: meta.lastChecked }); } catch(e) {}
      }
      return res.json({ success: true, items: out });
    }

    if (action === 'delete') {
      const id = body.id;
      if (!id) return res.status(400).json({ success: false, message: 'Missing id' });
      await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'DEL', `gh_token:${id}`);
      await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'LREM', 'gh_tokens', '0', id);
      return res.json({ success: true });
    }

    if (action === 'check') {
      const id = body.id;
      if (!id) return res.status(400).json({ success: false, message: 'Missing id' });
      const raw = await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'GET', `gh_token:${id}`);
      if (!raw) return res.status(404).json({ success: false, message: 'Not found' });
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch(e) { return res.status(500).json({ success: false, message: 'Corrupt data' }); }
      const token = parsed.token;
      const me = await ghFetch('https://api.github.com/user', 'GET', token);
      if (me.status !== 200 || !me.data.login) {
        // mark dead
        parsed.meta = { ...(parsed.meta || {}), lastChecked: new Date().toISOString(), status: 'dead' };
        await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'SET', `gh_token:${id}`, JSON.stringify(parsed));
        return res.json({ success: true, live: false });
      }
      // mark live
      parsed.meta = { ...(parsed.meta || {}), lastChecked: new Date().toISOString(), status: 'live' };
      await upstashCall(UPSTASH_URL, UPSTASH_TOKEN, 'SET', `gh_token:${id}`, JSON.stringify(parsed));
      return res.json({ success: true, live: true });
    }

    return res.status(400).json({ success: false, message: 'Unknown action' });
  } catch (err) {
    console.error('[tokens] error', err);
    return res.status(500).json({ success: false, message: String(err) });
  }
};
