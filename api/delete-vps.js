async function ghFetch(url, method, token, body, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const options = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "CodeCloud-VPS/1.0"
        }
      };
      if (body) options.body = JSON.stringify(body);
      
      const res = await fetch(url, options);
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cancelAllWorkflows(repoPath, token) {
  const statuses = ['in_progress', 'queued', 'waiting', 'pending', 'requested'];
  let totalCancelled = 0;
  
  for (const status of statuses) {
    try {
      const runs = await ghFetch(
        `https://api.github.com/repos/${repoPath}/actions/runs?status=${status}&per_page=50`,
        "GET",
        token
      );
      
      if (runs.status === 200 && runs.data.workflow_runs?.length > 0) {
        console.log(`[delete-vps] Found ${runs.data.workflow_runs.length} ${status} workflows`);
        
        const cancelPromises = runs.data.workflow_runs.map(run => 
          ghFetch(
            `https://api.github.com/repos/${repoPath}/actions/runs/${run.id}/cancel`,
            "POST",
            token
          )
        );
        
        await Promise.all(cancelPromises);
        totalCancelled += runs.data.workflow_runs.length;
      }
    } catch (e) {
      console.log(`[delete-vps] Error cancelling ${status}:`, e.message);
    }
  }
  
  return totalCancelled;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const { githubToken, owner, repo } = req.body || {};

    if (!githubToken) {
      return res.status(400).json({ success: false, message: "Thiếu GitHub Token" });
    }
    if (!owner || !repo) {
      return res.status(400).json({ success: false, message: "Thiếu owner hoặc repo" });
    }

    const repoPath = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    // Check if repo exists
    const checkRepo = await ghFetch(
      `https://api.github.com/repos/${repoPath}`,
      "GET",
      githubToken
    );

    if (checkRepo.status === 404) {
      return res.json({ 
        success: true, 
        message: "Repository không tồn tại hoặc đã bị xoá" 
      });
    }

    // Cancel all workflows first
    console.log(`[delete-vps] Cancelling workflows for ${repoPath}...`);
    const cancelledCount = await cancelAllWorkflows(repoPath, githubToken);
    
    if (cancelledCount > 0) {
      console.log(`[delete-vps] Cancelled ${cancelledCount} workflows`);
      await sleep(3000);
    }

    // Delete repo
    const deleteResult = await ghFetch(
      `https://api.github.com/repos/${repoPath}`,
      "DELETE",
      githubToken
    );

    if (deleteResult.status === 204) {
      return res.json({ 
        success: true, 
        message: `✅ Đã xoá repository${cancelledCount > 0 ? ` và huỷ ${cancelledCount} workflows` : ''}` 
      });
    }

    if (deleteResult.status === 403) {
      const needsDeleteScope = deleteResult.data?.message?.includes("delete_repo") || 
                               deleteResult.data?.message?.includes("scope");
      
      return res.status(403).json({ 
        success: false, 
        message: needsDeleteScope 
          ? "Token cần quyền 'delete_repo'. Tạo token mới với scope này."
          : "Không có quyền xoá repository",
        detail: deleteResult.data
      });
    }

    if (deleteResult.status === 404) {
      return res.json({ success: true, message: "Repository đã được xoá" });
    }

    return res.status(deleteResult.status || 500).json({
      success: false,
      message: "Lỗi khi xoá repository",
      status: deleteResult.status,
      detail: deleteResult.data
    });

  } catch (err) {
    console.error("[delete-vps] Error:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Lỗi server", 
      error: String(err) 
    });
  }
};