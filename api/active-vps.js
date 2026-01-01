// API endpoint to fetch active VPS list from Upstash Redis

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
    const d = await r.json();
    return d.result;
  } catch (e) {
    console.error('Upstash error:', e);
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Get all active VPS keys
    const keys = await upstash('SMEMBERS', 'active_vps_keys');
    
    if (!keys || keys.length === 0) {
      return res.json({ success: true, items: [] });
    }

    const items = [];
    for (const key of keys) {
      try {
        const raw = await upstash('GET', key);
        if (raw) {
          const parsed = JSON.parse(raw);
          items.push(parsed);
        }
      } catch (e) {
        // Skip malformed entries
        continue;
      }
    }

    // Sort by createdAt descending
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.json({ success: true, items });
  } catch (err) {
    console.error('[active-vps] error:', err);
    return res.status(500).json({ success: false, message: String(err) });
  }
};
