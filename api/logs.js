// Logs API - Fetch system logs from Upstash Redis

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
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method not allowed' });

  try {
    // Get last 200 logs from 'userlogs' list
    const rawLogs = await upstash('LRANGE', 'userlogs', '0', '199');
    
    if (!rawLogs || rawLogs.length === 0) {
      return res.json({ success: true, items: [] });
    }
    
    const items = [];
    for (const raw of rawLogs) {
      try {
        const parsed = JSON.parse(raw);
        items.push(parsed);
      } catch {
        // Skip invalid entries
      }
    }
    
    return res.json({ success: true, items });
  } catch (err) {
    console.error('[logs] error:', err);
    return res.status(500).json({ success: false, message: String(err) });
  }
};
