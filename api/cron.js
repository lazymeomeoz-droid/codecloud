// Cron endpoint for Vercel
// 1. Re-checks saved GitHub PATs older than 48 hours
// 2. Auto-deletes expired VPS repos
// Configure in vercel.json: { "crons": [{ "path": "/api/cron", "schedule": "*/30 * * * *" }] }

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

// Get token by ID
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

// Cancel all workflows for a repo
async function cancelAllWorkflows(repoPath, token) {
  const statuses = ['in_progress', 'queued', 'waiting', 'pending', 'requested'];
  let totalCancelled = 0;

  for (const status of statuses) {
    try {
      const runs = await ghFetch(
        `https://api.github.com/repos/${repoPath}/actions/runs?status=${status}&per_page=50`,
        'GET',
        token
      );

      if (runs.status === 200 && runs.data.workflow_runs?.length > 0) {
        const cancelPromises = runs.data.workflow_runs.map(run =>
          ghFetch(
            `https://api.github.com/repos/${repoPath}/actions/runs/${run.id}/cancel`,
            'POST',
            token
          )
        );
        await Promise.all(cancelPromises);
        totalCancelled += runs.data.workflow_runs.length;
      }
    } catch (e) {
      console.log(`[cron] Error cancelling ${status}:`, e.message);
    }
  }

  return totalCancelled;
}

// Delete expired VPS
async function cleanupExpiredVps() {
  const results = [];
  const now = Date.now();
  
  // Get all active VPS keys
  const keys = await upstash('SMEMBERS', 'active_vps_keys');
  if (!keys || keys.length === 0) {
    return { checked: 0, deleted: 0, results };
  }
  
  console.log(`[cron] Checking ${keys.length} active VPS for expiration...`);
  
  let deleted = 0;
  
  for (const key of keys) {
    try {
      const raw = await upstash('GET', key);
      if (!raw) {
        // Key doesn't exist, remove from set
        await upstash('SREM', 'active_vps_keys', key);
        results.push({ key, status: 'missing' });
        continue;
      }
      
      const vps = JSON.parse(raw);
      const expiresAt = new Date(vps.expiresAt).getTime();
      
      // Check if expired
      if (now < expiresAt) {
        const remainingMinutes = Math.round((expiresAt - now) / 60000);
        results.push({ key, status: 'active', remaining: `${remainingMinutes}m` });
        continue;
      }
      
      console.log(`[cron] VPS expired: ${vps.owner}/${vps.repo}`);
      
      // Get token used to create this VPS
      const token = await getTokenById(vps.tokenId);
      if (!token) {
        console.log(`[cron] Token ${vps.tokenId} not found, cannot delete repo`);
        results.push({ key, status: 'token_missing', owner: vps.owner, repo: vps.repo });
        // Still remove from tracking since we can't manage it
        await upstash('DEL', key);
        await upstash('SREM', 'active_vps_keys', key);
        continue;
      }
      
      const repoPath = `${vps.owner}/${vps.repo}`;
      
      // Check if repo exists
      const checkRepo = await ghFetch(
        `https://api.github.com/repos/${repoPath}`,
        'GET',
        token
      );
      
      if (checkRepo.status === 404) {
        console.log(`[cron] Repo ${repoPath} already deleted`);
        await upstash('DEL', key);
        await upstash('SREM', 'active_vps_keys', key);
        results.push({ key, status: 'already_deleted', owner: vps.owner, repo: vps.repo });
        continue;
      }
      
      // Cancel workflows first
      const cancelledCount = await cancelAllWorkflows(repoPath, token);
      if (cancelledCount > 0) {
        console.log(`[cron] Cancelled ${cancelledCount} workflows for ${repoPath}`);
        await sleep(3000);
      }
      
      // Delete repo
      const deleteRes = await ghFetch(
        `https://api.github.com/repos/${repoPath}`,
        'DELETE',
        token
      );
      
      if (deleteRes.status === 204 || deleteRes.status === 404) {
        console.log(`[cron] Successfully deleted ${repoPath}`);
        await upstash('DEL', key);
        await upstash('SREM', 'active_vps_keys', key);
        deleted++;
        results.push({ 
          key, 
          status: 'deleted', 
          owner: vps.owner, 
          repo: vps.repo,
          cancelledWorkflows: cancelledCount
        });
        
        // Log the auto-deletion
        const logEntry = {
          type: 'vps_auto_deleted',
          at: new Date().toISOString(),
          owner: vps.owner,
          repo: vps.repo,
          reason: 'expired',
          createdAt: vps.createdAt,
          expiresAt: vps.expiresAt
        };
        await upstash('LPUSH', 'userlogs', JSON.stringify(logEntry));
        await upstash('LTRIM', 'userlogs', '0', '499');
      } else {
        console.log(`[cron] Failed to delete ${repoPath}: ${deleteRes.status}`);
        results.push({ 
          key, 
          status: 'delete_failed', 
          owner: vps.owner, 
          repo: vps.repo,
          error: deleteRes.data?.message || `HTTP ${deleteRes.status}`
        });
      }
      
      // Small delay between deletions
      await sleep(1000);
      
    } catch (e) {
      console.log(`[cron] Error processing ${key}:`, e.message);
      results.push({ key, status: 'error', error: e.message });
    }
  }
  
  return { checked: keys.length, deleted, results };
}

// Check token health
async function checkTokenHealth() {
  const ids = await upstash('LRANGE', 'gh_tokens', '0', '-1');
  if (!ids || ids.length === 0) {
    return { checked: 0, results: [] };
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

  return { checked: results.length, results };
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
    console.log('[cron] Starting cron job...');
    
    // 1. Cleanup expired VPS
    console.log('[cron] Checking for expired VPS...');
    const cleanupResults = await cleanupExpiredVps();
    console.log(`[cron] Cleanup: checked=${cleanupResults.checked}, deleted=${cleanupResults.deleted}`);
    
    // 2. Check token health
    console.log('[cron] Checking token health...');
    const tokenResults = await checkTokenHealth();
    console.log(`[cron] Tokens: checked=${tokenResults.checked}`);

    return res.json({ 
      success: true, 
      timestamp: new Date().toISOString(),
      vpsCleanup: {
        checked: cleanupResults.checked,
        deleted: cleanupResults.deleted,
        results: cleanupResults.results
      },
      tokenHealth: {
        checked: tokenResults.checked,
        results: tokenResults.results
      }
    });
  } catch (err) {
    console.error('[cron] error', err);
    return res.status(500).json({ success: false, message: String(err) });
  }
};
