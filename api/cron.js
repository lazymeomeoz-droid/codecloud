// Cron endpoint for Vercel
// Schedule: once per day at 00:00 UTC (Vercel Hobby compatible)
// 1. Re-checks saved GitHub PATs older than 48 hours
// 2. Auto-deletes expired VPS repos
//
// VERCEL CRON PRICING:
// - Hobby (Free): 1 cron job, runs once per day minimum
// - Pro: Multiple crons, can run every minute
// Schedule in vercel.json: "0 0 * * *" = daily at midnight UTC

const MAX_VPS_PER_RUN = 10;
const MAX_TOKENS_PER_RUN = 5;

async function upstash(command, ...args) {
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.log('[cron] Upstash not configured');
    return null;
  }
  
  try {
    const r = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${UPSTASH_TOKEN}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify([command, ...args])
    });
    
    if (!r.ok) {
      console.error('[cron] Upstash HTTP error:', r.status);
      return null;
    }
    
    const j = await r.json();
    return j.result;
  } catch (e) {
    console.error('[cron] Upstash error:', e.message);
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
    console.error('[cron] GitHub API error:', e.message);
    return { status: 0, error: e.message };
  }
}

async function getTokenById(tokenId) {
  if (!tokenId) return null;
  
  const raw = await upstash('GET', `gh_token:${tokenId}`);
  if (!raw) return null;
  
  try {
    const parsed = JSON.parse(raw);
    return parsed.token || null;
  } catch (e) {
    console.error('[cron] Token parse error:', e.message);
    return null;
  }
}

async function cancelActiveWorkflows(repoPath, token) {
  let cancelled = 0;
  
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
        cancelled++;
        await sleep(500);
      }
    }
  } catch (e) {
    console.log('[cron] Cancel workflows error:', e.message);
  }
  
  return cancelled;
}

async function cleanupExpiredVps() {
  const results = [];
  const now = Date.now();
  
  const keys = await upstash('SMEMBERS', 'active_vps_keys');
  
  if (!keys || !Array.isArray(keys) || keys.length === 0) {
    console.log('[cron] No active VPS keys found');
    return { checked: 0, deleted: 0, total: 0, results };
  }
  
  console.log(`[cron] Found ${keys.length} VPS keys`);
  
  let deleted = 0;
  let checked = 0;
  
  const vpsData = [];
  
  for (const key of keys.slice(0, MAX_VPS_PER_RUN * 2)) {
    const raw = await upstash('GET', key);
    
    if (!raw) {
      console.log(`[cron] Removing orphan key: ${key}`);
      await upstash('SREM', 'active_vps_keys', key);
      continue;
    }
    
    try {
      const vps = JSON.parse(raw);
      vps._key = key;
      vpsData.push(vps);
    } catch (e) {
      console.log(`[cron] Invalid VPS data for ${key}, removing`);
      await upstash('SREM', 'active_vps_keys', key);
    }
  }
  
  // Sort: expired first
  vpsData.sort((a, b) => {
    const aExpired = now > new Date(a.expiresAt).getTime();
    const bExpired = now > new Date(b.expiresAt).getTime();
    if (aExpired && !bExpired) return -1;
    if (!aExpired && bExpired) return 1;
    return new Date(a.expiresAt) - new Date(b.expiresAt);
  });
  
  for (const vps of vpsData.slice(0, MAX_VPS_PER_RUN)) {
    checked++;
    const key = vps._key;
    const expiresAt = new Date(vps.expiresAt).getTime();
    
    if (now < expiresAt) {
      const remainingMinutes = Math.round((expiresAt - now) / 60000);
      results.push({ key, status: 'active', remaining: `${remainingMinutes}m` });
      continue;
    }
    
    console.log(`[cron] VPS expired: ${vps.owner}/${vps.repo}`);
    
    const token = await getTokenById(vps.tokenId);
    
    if (!token) {
      console.log(`[cron] Token ${vps.tokenId} not found, cleaning up`);
      await upstash('DEL', key);
      await upstash('SREM', 'active_vps_keys', key);
      results.push({ key, status: 'token_missing', owner: vps.owner, repo: vps.repo });
      deleted++;
      continue;
    }
    
    const repoPath = `${vps.owner}/${vps.repo}`;
    
    // Check repo exists
    const checkRepo = await ghFetch(`https://api.github.com/repos/${repoPath}`, 'GET', token);
    
    if (checkRepo.status === 404) {
      console.log(`[cron] Repo ${repoPath} already deleted`);
      await upstash('DEL', key);
      await upstash('SREM', 'active_vps_keys', key);
      results.push({ key, status: 'already_deleted', owner: vps.owner, repo: vps.repo });
      deleted++;
      continue;
    }
    
    // Cancel workflows
    const cancelledCount = await cancelActiveWorkflows(repoPath, token);
    if (cancelledCount > 0) {
      console.log(`[cron] Cancelled ${cancelledCount} workflows`);
      await sleep(2000);
    }
    
    // Delete repo
    const deleteRes = await ghFetch(`https://api.github.com/repos/${repoPath}`, 'DELETE', token);
    
    if (deleteRes.status === 204 || deleteRes.status === 404) {
      console.log(`[cron] Deleted ${repoPath}`);
      await upstash('DEL', key);
      await upstash('SREM', 'active_vps_keys', key);
      deleted++;
      results.push({ key, status: 'deleted', owner: vps.owner, repo: vps.repo });
      
      // Log
      const logEntry = {
        type: 'vps_auto_deleted',
        at: new Date().toISOString(),
        owner: vps.owner,
        repo: vps.repo,
        reason: 'expired'
      };
      await upstash('LPUSH', 'userlogs', JSON.stringify(logEntry));
      await upstash('LTRIM', 'userlogs', '0', '499');
    } else {
      console.log(`[cron] Failed to delete ${repoPath}: ${deleteRes.status}`);
      results.push({ key, status: 'delete_failed', error: deleteRes.data?.message || `HTTP ${deleteRes.status}` });
    }
    
    await sleep(1000);
  }
  
  return { checked, deleted, total: keys.length, results };
}

async function checkTokenHealth() {
  const ids = await upstash('LRANGE', 'gh_tokens', '0', '-1');
  
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    console.log('[cron] No tokens found');
    return { checked: 0, total: 0, results: [] };
  }

  const now = Date.now();
  const results = [];
  let checked = 0;

  for (const id of ids.slice(0, MAX_TOKENS_PER_RUN)) {
    try {
      const raw = await upstash('GET', `gh_token:${id}`);
      
      if (!raw) {
        results.push({ id, status: 'missing' });
        continue;
      }

      let parsed;
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
        results.push({ id, status: 'recent', owner: meta.owner });
        continue;
      }

      checked++;
      const token = parsed.token;
      
      if (!token) {
        results.push({ id, status: 'no_token' });
        continue;
      }
      
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

      await sleep(500);
    } catch (inner) {
      console.error('[cron] Token check error:', inner.message);
      results.push({ id, status: 'error', error: String(inner.message) });
    }
  }

  return { checked, total: ids.length, results };
}

module.exports = async function handler(req, res) {
  // Set headers
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Allow GET and POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const startTime = Date.now();
  
  console.log('[cron] ========== CRON JOB STARTED ==========')
  console.log('[cron] Time:', new Date().toISOString());
  
  try {
    // 1. Cleanup expired VPS
    console.log('[cron] Step 1: Cleanup expired VPS...');
    const cleanupResults = await cleanupExpiredVps();
    console.log(`[cron] Cleanup done: checked=${cleanupResults.checked}, deleted=${cleanupResults.deleted}`);
    
    // 2. Check token health
    console.log('[cron] Step 2: Check token health...');
    const tokenResults = await checkTokenHealth();
    console.log(`[cron] Token check done: checked=${tokenResults.checked}`);

    const duration = Date.now() - startTime;
    
    console.log(`[cron] ========== CRON JOB COMPLETED in ${duration}ms ==========`);
    
    return res.status(200).json({ 
      success: true, 
      timestamp: new Date().toISOString(),
      duration: `${duration}ms`,
      vpsCleanup: {
        checked: cleanupResults.checked,
        deleted: cleanupResults.deleted,
        total: cleanupResults.total,
        results: cleanupResults.results
      },
      tokenHealth: {
        checked: tokenResults.checked,
        total: tokenResults.total,
        results: tokenResults.results
      },
      pricing: {
        plan: 'Vercel Hobby (Free)',
        schedule: 'Daily at 00:00 UTC',
        note: 'Use Admin Panel button for manual cleanup anytime'
      }
    });
  } catch (err) {
    console.error('[cron] FATAL ERROR:', err);
    return res.status(500).json({ 
      success: false, 
      message: String(err.message || err),
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
};
