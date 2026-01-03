// API to manually delete a VPS (admin or owner)

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getLiveToken() {
  const ids = await upstash('LRANGE', 'gh_tokens', '0', '-1');
  if (!ids || ids.length === 0) return null;
  
  for (const id of ids) {
    const raw = await upstash('GET', `gh_token:${id}`);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const meta = parsed.meta || {};
      if (meta.status === 'live' && parsed.token) {
        return { id, token: parsed.token, owner: meta.owner };
      }
    } catch (e) { continue; }
  }
  return null;
}

async function getTokenById(tokenId) {
  const raw = await upstash('GET', `gh_token:${tokenId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed.token;
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

  try {
    const { owner, repo } = req.body || {};
    
    if (!owner || !repo) {
      return res.status(400).json({ success: false, message: 'Missing owner or repo' });
    }

    const repoPath = `${owner}/${repo}`;
    const key = `active_vps:${owner}:${repo}`;
    
    // Try to get token from VPS record first
    let token = null;
    const vpsRaw = await upstash('GET', key);
    if (vpsRaw) {
      try {
        const vps = JSON.parse(vpsRaw);
        if (vps.tokenId) {
          token = await getTokenById(vps.tokenId);
        }
      } catch (e) {}
    }
    
    // Fallback to any live token
    if (!token) {
      const tokenData = await getLiveToken();
      if (tokenData) token = tokenData.token;
    }
    
    if (!token) {
      return res.status(500).json({ success: false, message: 'No available token to delete repo' });
    }

    // Cancel workflows first
    try {
      const runs = await ghFetch(
        `https://api.github.com/repos/${repoPath}/actions/runs?status=in_progress&per_page=10`,
        'GET',
        token
      );
      if (runs.status === 200 && runs.data.workflow_runs?.length > 0) {
        for (const run of runs.data.workflow_runs.slice(0, 5)) {
          await ghFetch(
            `https://api.github.com/repos/${repoPath}/actions/runs/${run.id}/cancel`,
            'POST',
            token
          );
        }
        await sleep(2000);
      }
    } catch (e) {
      console.log('[delete-vps] Error cancelling workflows:', e.message);
    }

    // Delete the repo
    const deleteRes = await ghFetch(`https://api.github.com/repos/${repoPath}`, 'DELETE', token);
    
    // Clean up Redis regardless of GitHub result
    await upstash('DEL', key);
    await upstash('SREM', 'active_vps_keys', key);
    
    if (deleteRes.status === 204 || deleteRes.status === 404) {
      // Log the deletion
      const logEntry = {
        type: 'vps_deleted',
        at: new Date().toISOString(),
        owner,
        repo,
        manual: true
      };
      await upstash('LPUSH', 'userlogs', JSON.stringify(logEntry));
      await upstash('LTRIM', 'userlogs', '0', '499');
      
      return res.json({ success: true, message: 'VPS deleted' });
    } else {
      return res.json({ 
        success: true, 
        message: 'Cleaned from database (GitHub deletion may have failed)',
        githubStatus: deleteRes.status,
        githubError: deleteRes.data?.message
      });
    }
  } catch (err) {
    console.error('[delete-vps] error:', err);
    return res.status(500).json({ success: false, message: String(err) });
  }
};
