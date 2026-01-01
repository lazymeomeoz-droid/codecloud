import { Octokit } from "octokit";
import fs from 'fs';
import path from 'path';

// Helper to call GitHub API with retries
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

const DATA_DIR = path.join(process.cwd(), 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const VPS_FILE = path.join(DATA_DIR, 'vps.json');

export default async function handler(req, res) {
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
    const { owner, repo } = req.body || {};
    let { githubToken } = req.body || {};

    if (!owner || !repo) {
      return res.status(400).json({ success: false, message: "Thiếu owner hoặc repo" });
    }

    // Try local tokens.json store
    const tokens = fs.existsSync(TOKENS_FILE) ? JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8') || '[]') : [];
    const tokenData = tokens.find(t => t.owner && owner && t.owner.toLowerCase() === owner.toLowerCase());
    if (tokenData && !githubToken) githubToken = tokenData.token;

    // If still no token, attempt Upstash lookup (best-effort)
    if (!githubToken) {
      const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
      const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (UPSTASH_URL && UPSTASH_TOKEN) {
        try {
          const r = await fetch(UPSTASH_URL, { method: 'POST', headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['LRANGE', 'gh_tokens', '0', '-1']) });
          const j = await r.json();
          const ids = Array.isArray(j.result) ? j.result : [];
          for (const id of ids) {
            const g = await fetch(UPSTASH_URL, { method: 'POST', headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['GET', `gh_token:${id}`]) });
            const gj = await g.json();
            if (gj.result) {
              try {
                const parsed = JSON.parse(gj.result);
                const token = parsed.token;
                const meta = parsed.meta || {};
                if (meta.owner && owner && meta.owner.toLowerCase() === owner.toLowerCase()) {
                  githubToken = token;
                  break;
                }
              } catch (e) { /* ignore parse errors */ }
            }
          }
        } catch (e) {
          console.log('[delete-vps] Upstash lookup error', e.message);
        }
      }
    }

    if (!githubToken) {
      return res.status(400).json({ success: false, message: "Thiếu GitHub Token và không tìm thấy token lưu" });
    }

    const repoPath = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    // Check if repo exists
    const checkRepo = await ghFetch(
      `https://api.github.com/repos/${repoPath}`,
      "GET",
      githubToken
    );

    if (checkRepo.status === 404) {
      // Optionally remove from local VPS_FILE if present
      if (fs.existsSync(VPS_FILE)) {
        let vpsList = JSON.parse(fs.readFileSync(VPS_FILE, 'utf8') || '[]');
        const newList = vpsList.filter(v => !(v.repo === repo && (!v.owner || v.owner.toLowerCase() === owner.toLowerCase())));
        if (newList.length !== vpsList.length) fs.writeFileSync(VPS_FILE, JSON.stringify(newList, null, 2));
      }

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
      // Remove from local VPS_FILE if present
      if (fs.existsSync(VPS_FILE)) {
        let vpsList = JSON.parse(fs.readFileSync(VPS_FILE, 'utf8') || '[]');
        const newList = vpsList.filter(v => !(v.repo === repo && (!v.owner || v.owner.toLowerCase() === owner.toLowerCase())));
        if (newList.length !== vpsList.length) fs.writeFileSync(VPS_FILE, JSON.stringify(newList, null, 2));
      }

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
}