// Cron endpoint for Vercel
// Re-checks saved GitHub PATs older than 48 hours
// Configure in vercel.json: { "crons": [{ "path": "/api/cron", "schedule": "0 0 * * *" }] }

async function upstash(command, ...args) {
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const r = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([command, ...args])
    });
    const j = await r.json();
    return j.result;
  } catch (e) {
    console.error('Upstash error:', e);
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function ghFetch(url, method, token, body) {
  try {
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'CodeCloud-VPS/1.0'
      }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const text = await res.text();
    try {
      return { status: res.status, data: text ? JSON.parse(text) : {} };
    } catch {
      return { status: res.status, data: { raw: text } };
    }
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Vercel Cron uses GET requests
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    // Get all token IDs
    const ids = await upstash('LRANGE', 'gh_tokens', '0', '-1');
    if (!ids || ids.length === 0) {
      return res.json({ success: true, checked: 0, message: 'No tokens to check' });
    }

    const now = Date.now();
    const results = [];

    for (const id of ids) {
      try {
        const raw = await upstash('GET', `gh_token:${id}`);
        if (!raw) {
          results.push({ id, status: 'missing' });
          continue;
        }

        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          results.push({ id, status: 'corrupt' });
          continue;
        }

        const meta = parsed.meta || {};
        const last = meta.lastChecked ? new Date(meta.lastChecked).getTime() : 0;

        // Skip if checked within 48 hours
        if (now - last < 48 * 3600 * 1000) {
          results.push({ id, status: 'recent' });
          continue;
        }

        // Perform quick check
        const token = parsed.token;
        const me = await ghFetch('https://api.github.com/user', 'GET', token);

        if (me.status !== 200 || !me.data?.login) {
          meta.lastChecked = new Date().toISOString();
          meta.status = 'dead';
          parsed.meta = meta;
          await upstash('SET', `gh_token:${id}`, JSON.stringify(parsed));
          results.push({ id, status: 'dead' });
          continue;
        }

        meta.lastChecked = new Date().toISOString();
        meta.status = 'live';
        meta.owner = me.data.login;
        parsed.meta = meta;
        await upstash('SET', `gh_token:${id}`, JSON.stringify(parsed));
        results.push({ id, status: 'live', owner: me.data.login });

        // Small delay to avoid rate limits
        await sleep(300);
      } catch (inner) {
        results.push({ id, status: 'error', error: String(inner) });
      }
    }

    return res.json({ success: true, checked: results.length, results });
  } catch (err) {
    console.error('[cron] error', err);
    return res.status(500).json({ success: false, message: String(err) });
  }
};
