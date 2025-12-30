// Token management for GitHub PATs
// Stores tokens in Upstash Redis under keys:
// - list 'gh_tokens' contains token ids
// - key `gh_token:<id>` stores JSON { id, owner, masked, createdAt, lastChecked, status }

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

async function upstash(url, token, cmd, ...args) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify([cmd, ...args]) });
    const j = await r.json();
    return j.result;
  } catch (e) { console.error('Upstash error', e); return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ghFetch(url, method, token, body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const opts = { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'CodeCloud-VPS/1.0' } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);
      const text = await res.text();
      try { return { status: res.status, data: text ? JSON.parse(text) : {} }; } catch { return { status: res.status, data: { raw: text } }; }
    } catch (e) {
      if (i < retries - 1) await sleep(1000 * Math.pow(2, i)); else return { status: 0, error: e.message };
    }
  }
  return { status: 0, error: 'Max retries' };
}

function maskToken(tok) { if (!tok) return ''; return tok.slice(0, 4) + '...' + tok.slice(-4); }

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

      // Create test repo
      const testRepo = `cc-token-check-${Date.now()}`;
      const create = await ghFetch('https://api.github.com/user/repos', 'POST', pat, { name: testRepo, auto_init: true, private: true });
      if (create.status !== 201) {
        return res.status(500).json({ success: false, message: 'Failed to create test repo', detail: create.data });
      }

      // push workflow
      const content = Buffer.from(TEST_WORKFLOW, 'utf8').toString('base64');
      const push = await ghFetch(`https://api.github.com/repos/${owner}/${testRepo}/contents/.github/workflows/check.yml`, 'PUT', pat, { message: 'Add token check workflow', content, branch: 'main' });
      if (push.status !== 201 && push.status !== 200) {
        // cleanup repo
        await ghFetch(`https://api.github.com/repos/${owner}/${testRepo}`, 'DELETE', pat);
        return res.status(500).json({ success: false, message: 'Failed to push check workflow', detail: push.data });
      }

      // dispatch
      const dispatch = await ghFetch(`https://api.github.com/repos/${owner}/${testRepo}/actions/workflows/check.yml/dispatches`, 'POST', pat, { ref: 'main' });
      let live = false; let checkDetail = null;
      if (dispatch.status === 204) {
        // wait small time for run to appear
        for (let i = 0; i < 12; i++) {
          await sleep(2500);
          const runs = await ghFetch(`https://api.github.com/repos/${owner}/${testRepo}/actions/runs?per_page=1`, 'GET', pat);
          if (runs.status === 200 && runs.data.workflow_runs && runs.data.workflow_runs.length > 0) { live = true; break; }
        }
      } else {
        checkDetail = dispatch.data;
      }

      // cleanup repo
      await ghFetch(`https://api.github.com/repos/${owner}/${testRepo}`, 'DELETE', pat);

      if (!live) return res.json({ success: false, live: false, message: 'Token failed check', detail: checkDetail });

      // store token id in list
      const id = String(Date.now());
      const obj = { id, owner, masked: `ghp_${(pat.slice(4,9) || '').replace(/"/g,'')}`, createdAt: new Date().toISOString(), lastChecked: new Date().toISOString(), status: 'live' };
      await upstash(UPSTASH_URL, UPSTASH_TOKEN, 'SET', `gh_token:${id}`, JSON.stringify({ token: pat, meta: obj }));
      await upstash(UPSTASH_URL, UPSTASH_TOKEN, 'RPUSH', 'gh_tokens', id);

      return res.json({ success: true, live: true, token: obj });
    }

    if (action === 'list') {
      const ids = await upstash(UPSTASH_URL, UPSTASH_TOKEN, 'LRANGE', 'gh_tokens', '0', '-1') || [];
      const out = [];
      for (const id of ids) {
        const raw = await upstash(UPSTASH_URL, UPSTASH_TOKEN, 'GET', `gh_token:${id}`);
        if (!raw) continue;
        try { const parsed = JSON.parse(raw); const meta = parsed.meta || {}; out.push(meta); } catch(e) {}
      }
      // trigger background recheck for tokens older than 48h (sync simple check)
      const now = Date.now();
      for (const t of out) {
        const last = t.lastChecked ? new Date(t.lastChecked).getTime() : 0;
        if (now - last > 48 * 3600 * 1000) {
          // fire and forget: call check endpoint
          (async () => {
            try { await fetch('/api/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'check', id: t.id }) }); } catch(e) {}
          })();
        }
      }

      return res.json({ success: true, items: out });
    }

    if (action === 'delete') {
      const id = body.id;
      if (!id) return res.status(400).json({ success: false, message: 'Missing id' });
      await upstash(UPSTASH_URL, UPSTASH_TOKEN, 'DEL', `gh_token:${id}`);
      // remove from list
      await upstash(UPSTASH_URL, UPSTASH_TOKEN, 'LREM', 'gh_tokens', '0', id);
      return res.json({ success: true });
    }

    if (action === 'check') {
      const id = body.id;
      if (!id) return res.status(400).json({ success: false, message: 'Missing id' });
      const raw = await upstash(UPSTASH_URL, UPSTASH_TOKEN, 'GET', `gh_token:${id}`);
      if (!raw) return res.status(404).json({ success: false, message: 'Not found' });
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch(e) { return res.status(500).json({ success: false, message: 'Corrupt data' }); }
      const token = parsed.token;
      // perform same quick check as add
      const me = await ghFetch('https://api.github.com/user', 'GET', token);
      if (me.status !== 200 || !me.data.login) {
        await upstash(UPSTASH_URL, UPSTASH_TOKEN, 'SET', `gh_token:${id}`, JSON.stringify({ token: token, meta: { ...parsed.meta, lastChecked: new Date().toISOString(), status: 'dead' } }));
        return res.json({ success: true, live: false });
      }
      // try create small repo and delete quickly
      const owner = me.data.login; const testRepo = `cc-token-check-${Date.now()}`;
      const create = await ghFetch('https://api.github.com/user/repos', 'POST', token, { name: testRepo, auto_init: true, private: true });
      if (create.status !== 201) {
        await upstash(UPSTASH_URL, UPSTASH_TOKEN, 'SET', `gh_token:${id}`, JSON.stringify({ token: token, meta: { ...parsed.meta, lastChecked: new Date().toISOString(), status: 'dead' } }));
        return res.json({ success: true, live: false });
      }
      // cleanup
      await ghFetch(`https://api.github.com/repos/${owner}/${testRepo}`, 'DELETE', token);
      await upstash(UPSTASH_URL, UPSTASH_TOKEN, 'SET', `gh_token:${id}`, JSON.stringify({ token: token, meta: { ...parsed.meta, lastChecked: new Date().toISOString(), status: 'live' } }));
      return res.json({ success: true, live: true });
    }

    return res.status(400).json({ success: false, message: 'Unknown action' });
  } catch (err) {
    console.error('[tokens] error', err);
    return res.status(500).json({ success: false, message: String(err) });
  }
};
