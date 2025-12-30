// Serverless endpoint: return recent deployment logs stored in Upstash Redis
// Reads list key 'deployments' (LRANGE 0 49) and returns parsed JSON entries.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ success: false, message: 'Upstash not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.' });
  }

  try {
    const r = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['LRANGE', 'deployments', '0', '49'])
    });

    const data = await r.json();
    const items = Array.isArray(data.result) ? data.result : [];

    const parsed = items.map(i => {
      try {
        const obj = JSON.parse(i);
        if (obj && obj.vpsPassword) obj.vpsPassword = 'REDACTED';
        return obj;
      } catch (e) {
        return i;
      }
    });

    return res.json({ success: true, items: parsed });
  } catch (err) {
    console.error('deployments API error:', err);
    return res.status(500).json({ success: false, message: String(err) });
  }
};
