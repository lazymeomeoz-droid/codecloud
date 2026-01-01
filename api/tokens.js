// GitHub Token Management API for Admin
// Actions: list, add, check, delete

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

function maskToken(token) {
  if (!token || token.length < 10) return '***';
  return token.slice(0, 8) + '****' + token.slice(-4);
}

function generateId() {
  return 'tok_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// Test token by creating a test repo, running workflow, then deleting
async function testToken(token) {
  // Step 1: Check /user
  const me = await ghFetch('https://api.github.com/user', 'GET', token);
  if (me.status !== 200 || !me.data?.login) {
    return { live: false, reason: 'Invalid token or expired', status: me.status };
  }
  
  const owner = me.data.login;
  const testRepoName = `cc-token-test-${Date.now()}`;
  
  try {
    // Step 2: Create test repo
    const createRes = await ghFetch('https://api.github.com/user/repos', 'POST', token, {
      name: testRepoName,
      private: true,
      auto_init: true,
      description: 'CodeCloud token test - will be deleted'
    });
    
    if (createRes.status !== 201) {
      const msg = createRes.data?.message || '';
      if (msg.includes('rate limit')) {
        return { live: false, reason: 'Rate limited', owner };
      }
      return { live: false, reason: 'Cannot create repo: ' + msg, owner };
    }
    
    await sleep(2000);
    
    // Step 3: Create simple workflow
    const workflowYml = `name: test\non: workflow_dispatch\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "OK"`;
    const content = Buffer.from(workflowYml).toString('base64');
    
    const putRes = await ghFetch(
      `https://api.github.com/repos/${owner}/${testRepoName}/contents/.github/workflows/test.yml`,
      'PUT',
      token,
      { message: 'Add test workflow', content, branch: 'main' }
    );
    
    if (putRes.status !== 201 && putRes.status !== 200) {
      // Cleanup
      await ghFetch(`https://api.github.com/repos/${owner}/${testRepoName}`, 'DELETE', token);
      return { live: false, reason: 'Cannot create workflow', owner };
    }
    
    await sleep(2000);
    
    // Step 4: Dispatch workflow
    const dispRes = await ghFetch(
      `https://api.github.com/repos/${owner}/${testRepoName}/actions/workflows/test.yml/dispatches`,
      'POST',
      token,
      { ref: 'main' }
    );
    
    if (dispRes.status !== 204) {
      const msg = dispRes.data?.message || '';
      // Cleanup
      await ghFetch(`https://api.github.com/repos/${owner}/${testRepoName}`, 'DELETE', token);
      
      if (msg.includes('rate limit') || msg.includes('secondary rate limit')) {
        return { live: false, reason: 'Rate limited (Actions)', owner };
      }
      return { live: false, reason: 'Cannot dispatch workflow: ' + msg, owner };
    }
    
    // Step 5: Wait for run to appear (max 30s)
    let runFound = false;
    for (let i = 0; i < 10; i++) {
      await sleep(3000);
      const runs = await ghFetch(
        `https://api.github.com/repos/${owner}/${testRepoName}/actions/runs?per_page=1`,
        'GET',
        token
      );
      if (runs.status === 200 && runs.data.workflow_runs?.length > 0) {
        runFound = true;
        break;
      }
    }
    
    // Cleanup
    await ghFetch(`https://api.github.com/repos/${owner}/${testRepoName}`, 'DELETE', token);
    
    if (!runFound) {
      return { live: false, reason: 'Workflow did not start (may be rate limited)', owner };
    }
    
    return { live: true, owner };
    
  } catch (e) {
    // Cleanup on error
    try {
      await ghFetch(`https://api.github.com/repos/${owner}/${testRepoName}`, 'DELETE', token);
    } catch {}
    return { live: false, reason: 'Error: ' + e.message, owner };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

  try {
    const body = req.body || {};
    const { action, token, id } = body;

    // LIST tokens
    if (action === 'list') {
      const ids = await upstash('LRANGE', 'gh_tokens', '0', '-1') || [];
      const items = [];
      
      for (const tid of ids) {
        const raw = await upstash('GET', `gh_token:${tid}`);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          const meta = parsed.meta || {};
          items.push({
            id: tid,
            masked: maskToken(parsed.token),
            owner: meta.owner || 'unknown',
            status: meta.status || 'unknown',
            lastChecked: meta.lastChecked || null
          });
        } catch {}
      }
      
      return res.json({ success: true, items });
    }

    // ADD token (with full test)
    if (action === 'add') {
      if (!token) return res.status(400).json({ success: false, message: 'Missing token' });
      
      // Test the token
      const testResult = await testToken(token);
      
      if (!testResult.live) {
        return res.json({
          success: false,
          message: `Token DIE: ${testResult.reason}`,
          owner: testResult.owner || null
        });
      }
      
      // Token is live, save it
      const newId = generateId();
      const data = {
        token,
        meta: {
          owner: testResult.owner,
          status: 'live',
          lastChecked: new Date().toISOString(),
          addedAt: new Date().toISOString()
        }
      };
      
      await upstash('SET', `gh_token:${newId}`, JSON.stringify(data));
      await upstash('RPUSH', 'gh_tokens', newId);
      
      return res.json({
        success: true,
        message: 'Token LIVE - Đã lưu!',
        owner: testResult.owner,
        id: newId
      });
    }

    // CHECK single token
    if (action === 'check') {
      if (!id) return res.status(400).json({ success: false, message: 'Missing id' });
      
      const raw = await upstash('GET', `gh_token:${id}`);
      if (!raw) return res.status(404).json({ success: false, message: 'Token not found' });
      
      const parsed = JSON.parse(raw);
      const testResult = await testToken(parsed.token);
      
      parsed.meta = parsed.meta || {};
      parsed.meta.lastChecked = new Date().toISOString();
      parsed.meta.status = testResult.live ? 'live' : 'dead';
      if (testResult.owner) parsed.meta.owner = testResult.owner;
      
      await upstash('SET', `gh_token:${id}`, JSON.stringify(parsed));
      
      return res.json({
        success: true,
        live: testResult.live,
        message: testResult.live ? 'Token LIVE' : `Token DIE: ${testResult.reason}`,
        owner: testResult.owner || parsed.meta.owner
      });
    }

    // DELETE token
    if (action === 'delete') {
      if (!id) return res.status(400).json({ success: false, message: 'Missing id' });
      
      await upstash('DEL', `gh_token:${id}`);
      await upstash('LREM', 'gh_tokens', '0', id);
      
      return res.json({ success: true, message: 'Đã xoá token' });
    }

    return res.status(400).json({ success: false, message: 'Unknown action' });

  } catch (err) {
    console.error('[tokens] error:', err);
    return res.status(500).json({ success: false, message: String(err) });
  }
};
