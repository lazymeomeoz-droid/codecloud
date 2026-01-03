const AdmZip = require("adm-zip");

// Cache for successful results only
const resultCache = new Map();
const CACHE_TTL = 20000; // 20 seconds

function getCachedResult(key) {
  const cached = resultCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    if (cached.data && cached.data.found && cached.data.vpsLink) {
      return cached.data;
    }
  }
  resultCache.delete(key);
  return null;
}

function setCachedResult(key, data) {
  if (!data || !data.found || !data.vpsLink) return;
  if (resultCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of resultCache) {
      if (now - v.timestamp > CACHE_TTL) resultCache.delete(k);
    }
  }
  resultCache.set(key, { data, timestamp: Date.now() });
}

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

async function ghFetch(url, method, token, body, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);
      
      const options = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "CodeCloud-VPS/1.0"
        },
        signal: controller.signal
      };
      if (body) options.body = JSON.stringify(body);
      
      const urlWithCache = url.includes('?') 
        ? `${url}&_t=${Date.now()}` 
        : `${url}?_t=${Date.now()}`;
      
      const res = await fetch(urlWithCache, options);
      clearTimeout(timeoutId);
      
      const text = await res.text();
      let json;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      
      return { status: res.status, data: json };
    } catch (err) {
      if (attempt < retries - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      return { status: 0, data: {}, error: err.message };
    }
  }
  return { status: 0, data: {}, error: "Max retries reached" };
}

async function ghBinary(url, token, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "CodeCloud-VPS/1.0"
        },
        redirect: "follow",
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, 2000 * (i + 1)));
          continue;
        }
        return { status: res.status, buffer: null, error: `HTTP ${res.status}` };
      }

      const buffer = await res.arrayBuffer();
      return { status: res.status, buffer: Buffer.from(buffer) };
    } catch (err) {
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      return { status: 0, buffer: null, error: err.message };
    }
  }
  return { status: 0, buffer: null, error: "Max retries reached" };
}

function getStatusMessage(status, conclusion, extra = {}) {
  const { stepName, elapsedMinutes, currentStepNum, totalSteps, tailscaleAuthUrl } = extra;
  
  if (tailscaleAuthUrl) {
    return "🔐 Cần xác thực Tailscale! Click link bên dưới để đăng nhập.";
  }
  
  const baseMessages = {
    queued: "⏳ Workflow đang chờ trong hàng đợi GitHub...",
    pending: "⏳ Workflow đang chờ runner khả dụng...",
    waiting: "⏳ Workflow đang chờ runner...",
    requested: "📤 Workflow đã được yêu cầu, đang khởi tạo...",
    action_required: "⚠️ Workflow cần xác nhận thủ công trong GitHub Actions"
  };
  
  if (status === "in_progress") {
    let msg = "🔄 Đang cài đặt VPS";
    if (stepName) {
      msg += ` → ${stepName}`;
      if (currentStepNum && totalSteps) {
        msg += ` (${currentStepNum}/${totalSteps})`;
      }
    }
    if (elapsedMinutes && elapsedMinutes > 0) {
      msg += ` • ${elapsedMinutes}m`;
    }
    return msg;
  }
  
  if (status === "completed") {
    const conclusionMessages = {
      success: "✅ Workflow hoàn thành!",
      failure: "❌ Workflow thất bại. Kiểm tra GitHub Actions để xem chi tiết lỗi.",
      cancelled: "🚫 Workflow đã bị huỷ.",
      timed_out: "⏰ Workflow đã hết thời gian (timeout).",
      action_required: "⚠️ Workflow cần xác nhận manual approval.",
      stale: "📦 Workflow đã cũ, vui lòng tạo VPS mới.",
      skipped: "⏭️ Workflow đã bị bỏ qua."
    };
    return conclusionMessages[conclusion] || `Workflow kết thúc: ${conclusion || 'unknown'}`;
  }
  
  return baseMessages[status] || `Trạng thái: ${status}`;
}

function calculateProgress(status, conclusion, extra = {}) {
  const { elapsedMinutes = 0, currentStepNum = 0, totalSteps = 0, tailscaleAuthUrl } = extra;
  
  if (tailscaleAuthUrl) return 50;
  
  if (status === "queued" || status === "waiting" || status === "requested") {
    return Math.min(5 + elapsedMinutes, 15);
  }
  if (status === "pending") {
    return Math.min(10 + elapsedMinutes * 2, 25);
  }
  if (status === "in_progress") {
    if (totalSteps > 0 && currentStepNum > 0) {
      const stepProgress = (currentStepNum / totalSteps) * 60;
      return Math.min(25 + stepProgress, 85);
    }
    return Math.min(25 + elapsedMinutes * 4, 85);
  }
  if (status === "completed") {
    return conclusion === "success" ? 95 : 100;
  }
  return 0;
}

async function tryGetArtifactInfo(repoPath, runId, token) {
  console.log(`[find-link] Checking artifacts for run ${runId}`);
  
  const arts = await ghFetch(
    `https://api.github.com/repos/${repoPath}/actions/runs/${runId}/artifacts`,
    "GET",
    token
  );

  if (arts.error || !arts.data.artifacts) {
    console.log(`[find-link] Artifacts error: ${arts.error || 'No data'}`);
    return { found: false, error: arts.error || "No artifacts data" };
  }

  const artArr = arts.data.artifacts || [];
  console.log(`[find-link] Found ${artArr.length} artifacts`);
  
  if (artArr.length === 0) {
    return { found: false, reason: "no_artifacts" };
  }

  // Sort by created_at descending
  artArr.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const art = artArr.find(a => a.name === "result" && !a.expired) || artArr.find(a => !a.expired);
  
  if (!art) {
    return { found: false, reason: "all_expired" };
  }
  
  if (art.expired) {
    return { found: false, reason: "expired" };
  }

  console.log(`[find-link] Downloading: ${art.name} (${art.size_in_bytes} bytes)`);
  const bin = await ghBinary(art.archive_download_url, token);
  
  if (bin.status !== 200 || !bin.buffer) {
    console.log(`[find-link] Download failed: ${bin.status} ${bin.error}`);
    return { found: false, reason: "download_failed", error: bin.error };
  }

  if (bin.buffer.length === 0) {
    return { found: false, reason: "empty_buffer" };
  }

  console.log(`[find-link] Downloaded ${bin.buffer.length} bytes`);

  try {
    const zip = new AdmZip(bin.buffer);
    const entries = zip.getEntries();
    
    if (entries.length === 0) {
      return { found: false, reason: "empty_zip" };
    }

    const entry = zip.getEntry("info.txt");
    
    if (!entry) {
      return { found: false, reason: "no_info_file", files: entries.map(e => e.entryName) };
    }

    const content = zip.readAsText(entry).trim();
    console.log(`[find-link] Content: "${content)}"`);
    
    if (!content) {
      return { found: false, reason: "empty_content" };
    }

    const parts = content.split("|");
    const firstPart = parts[0]?.trim();
    const secondPart = parts[1]?.trim();
    
    // PENDING
    if (firstPart === "PENDING") {
      return { found: false, reason: "pending", message: secondPart };
    }
    
    // WAITING_AUTH (Tailscale)
    if (firstPart === "WAITING_AUTH" && secondPart) {
      console.log(`[find-link] Tailscale auth: ${secondPart}`);
      return { found: false, reason: "waiting_auth", tailscaleAuthUrl: secondPart };
    }
    
    // TIMEOUT
    if (firstPart === "TIMEOUT") {
      return { found: false, reason: "timeout", message: secondPart };
    }
    
    // ERROR
    if (firstPart && firstPart.toUpperCase().startsWith("ERROR")) {
      const errorMsg = secondPart || firstPart.replace(/ERROR:?/i, "").trim() || "Unknown error";
      console.log(`[find-link] Error: ${errorMsg}`);
      return { found: false, reason: "vps_error", error: errorMsg };
    }

    const url = firstPart;
    const password = secondPart;
    
    // Validate URL
    const isValidUrl = url && (
      url.startsWith("http://") || 
      url.startsWith("https://") || 
      /^[a-zA-Z0-9.-]+:\d+$/.test(url) ||
      /^\d+\.\d+\.\d+\.\d+:\d+$/.test(url) ||
      /^100\.\d+\.\d+\.\d+:\d+$/.test(url)
    );
    
    if (!isValidUrl) {
      console.log(`[find-link] Invalid URL: "${url)}"`);
      return { found: false, reason: "invalid_url", url: url || "empty" };
    }

    console.log(`[find-link] SUCCESS! URL: ${url}`);
    return {
      found: true,
      vpsLink: url,
      vpsPassword: password || null
    };

  } catch (zipErr) {
    console.log(`[find-link] Zip error: ${zipErr.message}`);
    return { found: false, reason: "zip_error", error: zipErr.message };
  }
}

// Get token from VPS record or pool
async function getTokenForVps(owner, repoName) {
  // Method 1: Try to get token from saved VPS record
  if (owner && repoName) {
    const vpsKey = `active_vps:${owner}:${repoName}`;
    const vpsRaw = await upstash('GET', vpsKey);
    if (vpsRaw) {
      try {
        const vps = JSON.parse(vpsRaw);
        if (vps.tokenId) {
          const tokenRaw = await upstash('GET', `gh_token:${vps.tokenId}`);
          if (tokenRaw) {
            const parsed = JSON.parse(tokenRaw);
            if (parsed.token) {
              console.log(`[find-link] Got token from VPS record: ${vps.tokenId}`);
              return { token: parsed.token, owner: parsed.meta?.owner };
            }
          }
        }
      } catch (e) {
        console.log(`[find-link] Error parsing VPS record:`, e.message);
      }
    }
  }
  
  // Method 2: Try to find token by owner
  if (owner) {
    const ids = await upstash('LRANGE', 'gh_tokens', '0', '-1');
    if (ids && ids.length > 0) {
      for (const id of ids) {
        const raw = await upstash('GET', `gh_token:${id}`);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          const meta = parsed.meta || {};
          if (meta.owner && meta.owner.toLowerCase() === owner.toLowerCase() && meta.status === 'live' && parsed.token) {
            console.log(`[find-link] Found token by owner: ${id}`);
            return { token: parsed.token, owner: meta.owner };
          }
        } catch (e) { continue; }
      }
    }
  }
  
  // Method 3: Use any live token from pool
  const ids = await upstash('LRANGE', 'gh_tokens', '0', '-1');
  if (ids && ids.length > 0) {
    for (const id of ids) {
      const raw = await upstash('GET', `gh_token:${id}`);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const meta = parsed.meta || {};
        if (meta.status === 'live' && parsed.token) {
          console.log(`[find-link] Using fallback live token: ${id}`);
          return { token: parsed.token, owner: meta.owner };
        }
      } catch (e) { continue; }
    }
  }
  
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const { owner, repoName, checkTailscaleAuth } = req.body || {};

    if (!repoName) {
      return res.status(400).json({ success: false, message: "Thiếu tên Repository" });
    }

    if (!owner) {
      return res.status(400).json({ success: false, message: "Thiếu owner" });
    }

    // Get token from pool
    const tokenData = await getTokenForVps(owner, repoName);
    if (!tokenData || !tokenData.token) {
      return res.status(500).json({ 
        success: false, 
        message: 'Không tìm thấy GitHub Token trong pool. Admin cần thêm token.',
        code: 'NO_TOKEN'
      });
    }

    const githubToken = tokenData.token;
    const repoPath = `${owner}/${encodeURIComponent(repoName)}`;
    const cacheKey = `${repoPath}:link`;

    // Check cache
    const cached = getCachedResult(cacheKey);
    if (cached && cached.found && cached.vpsLink) {
      console.log(`[find-link] Cache hit for ${repoPath}`);
      return res.json(cached);
    }

    // Check repo exists
    const repoCheck = await ghFetch(`https://api.github.com/repos/${repoPath}`, "GET", githubToken);
    if (repoCheck.status === 404) {
      return res.json({
        success: true,
        found: false,
        status: "repo_not_found",
        progress: 0,
        message: "❌ Repository không tồn tại. Vui lòng tạo VPS mới."
      });
    }

    // Get workflow runs
    const runs = await ghFetch(
      `https://api.github.com/repos/${repoPath}/actions/runs?per_page=5`,
      "GET",
      githubToken
    );

    if (runs.error) {
      return res.json({
        success: true,
        found: false,
        status: "api_error",
        progress: 0,
        message: `⚠️ Lỗi API: ${runs.error}`
      });
    }

    const runArr = runs.data.workflow_runs || [];
    
    if (runArr.length === 0) {
      return res.json({
        success: true,
        found: false,
        status: "no_runs",
        progress: 5,
        message: "⏳ Chưa có workflow run. Đang chờ GitHub Actions khởi động..."
      });
    }

    const run = runArr[0];
    const runId = run.id;
    const runStatus = run.status;
    const runConclusion = run.conclusion;
    const createdAt = new Date(run.created_at);
    const now = new Date();
    const elapsedMinutes = Math.floor((now - createdAt) / 60000);

    console.log(`[find-link] Run ${runId}: status=${runStatus}, conclusion=${runConclusion}, elapsed=${elapsedMinutes}m`);

    // Get job details
    let currentStep = null;
    let totalSteps = 0;
    let currentStepNum = 0;
    let artifactStepCompleted = false;
    
    const jobs = await ghFetch(
      `https://api.github.com/repos/${repoPath}/actions/runs/${runId}/jobs`,
      "GET",
      githubToken
    );
    
    if (jobs.status === 200 && jobs.data.jobs?.length > 0) {
      const job = jobs.data.jobs[0];
      if (job.steps) {
        totalSteps = job.steps.length;
        const activeStep = job.steps.find(s => s.status === "in_progress");
        const completedSteps = job.steps.filter(s => s.status === "completed");
        currentStepNum = completedSteps.length + (activeStep ? 1 : 0);
        
        if (activeStep) currentStep = activeStep.name;
        
        const uploadStep = job.steps.find(s => {
          const name = s.name.toLowerCase();
          return (name.includes('upload') || name.includes('artifact')) && 
                 s.status === "completed" && s.conclusion === "success";
        });
        
        if (uploadStep) artifactStepCompleted = true;
      }
    }

    // Check artifacts
    const shouldTryArtifact = 
      (runStatus === "completed") ||
      (runStatus === "in_progress" && artifactStepCompleted) ||
      (runStatus === "in_progress" && elapsedMinutes >= 2) ||
      checkTailscaleAuth;

    if (shouldTryArtifact) {
      const artifactResult = await tryGetArtifactInfo(repoPath, runId, githubToken);
      
      // Found VPS link
      if (artifactResult.found) {
        const result = {
          success: true,
          found: true,
          vpsLink: artifactResult.vpsLink,
          vpsPassword: artifactResult.vpsPassword,
          status: "ready",
          conclusion: runConclusion || "running",
          progress: 100,
          elapsedMinutes,
          runId,
          message: "✅ VPS đã sẵn sàng!"
        };
        setCachedResult(cacheKey, result);
        return res.json(result);
      }
      
      // Tailscale auth required
      if (artifactResult.reason === "waiting_auth" && artifactResult.tailscaleAuthUrl) {
        return res.json({
          success: true,
          found: false,
          status: "tailscale_auth_required",
          tailscaleAuthUrl: artifactResult.tailscaleAuthUrl,
          progress: 50,
          elapsedMinutes,
          currentStep,
          currentStepNum,
          totalSteps,
          runId,
          message: "🔐 Cần xác thực Tailscale!"
        });
      }
      
      // Timeout
      if (artifactResult.reason === "timeout") {
        return res.json({
          success: true,
          found: false,
          status: "tailscale_timeout",
          progress: 60,
          elapsedMinutes,
          runId,
          message: "⏰ Hết thời gian chờ Tailscale."
        });
      }
      
      // VPS error
      if (artifactResult.reason === "vps_error") {
        return res.json({
          success: true,
          found: false,
          status: "vps_error",
          progress: 100,
          message: `❌ Lỗi: ${artifactResult.error}`
        });
      }
      
      // Expired
      if (artifactResult.reason === "expired" || artifactResult.reason === "all_expired") {
        return res.json({
          success: true,
          found: false,
          status: "expired",
          progress: 100,
          message: "⚠️ Artifact đã hết hạn. Tạo VPS mới."
        });
      }
    }

    // Workflow failed
    if (runStatus === "completed" && runConclusion !== "success") {
      return res.json({
        success: true,
        found: false,
        status: runStatus,
        conclusion: runConclusion,
        progress: 100,
        message: getStatusMessage(runStatus, runConclusion, { elapsedMinutes }),
        actionsUrl: `https://github.com/${repoPath}/actions/runs/${runId}`
      });
    }

    // Still in progress
    const progressExtra = { elapsedMinutes, currentStepNum, totalSteps };
    const progress = calculateProgress(runStatus, runConclusion, progressExtra);
    const statusMessage = getStatusMessage(runStatus, runConclusion, {
      stepName: currentStep,
      elapsedMinutes,
      currentStepNum,
      totalSteps
    });

    return res.json({
      success: true,
      found: false,
      status: runStatus,
      conclusion: runConclusion,
      progress,
      elapsedMinutes,
      currentStep,
      currentStepNum,
      totalSteps,
      runId,
      message: statusMessage
    });

  } catch (err) {
    console.error("[find-link] Error:", err);
    return res.status(500).json({
      success: false,
      message: "Lỗi server",
      error: String(err)
    });
  }
};
