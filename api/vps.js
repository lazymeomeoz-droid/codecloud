// VPS API - Server-managed GitHub Token Pool
// Auto-saves deployment info for cleanup

const YAML_TEMPLATES = {
  ubuntu_web: `name: Linux NoVNC
on:
  workflow_dispatch:
concurrency:
  group: vps-\${{ github.repository }}
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: __TIMEOUT__
    steps:
    - uses: actions/checkout@v4
    - name: Setup Desktop
      run: |
        sudo apt-get update
        sudo apt-get install -y xfce4 xfce4-goodies tigervnc-standalone-server python3-websockify curl wget
        git clone --depth 1 https://github.com/novnc/noVNC.git ~/noVNC
    - name: Start VNC Server
      run: |
        mkdir -p ~/.vnc
        echo "__PASSWORD__" | vncpasswd -f > ~/.vnc/passwd
        chmod 600 ~/.vnc/passwd
        vncserver :1 -geometry 1920x1080 -depth 24
        ~/noVNC/utils/novnc_proxy --vnc localhost:5901 --listen 6080 &
        sleep 5
    - name: Start Tunnel
      run: |
        curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
        sudo dpkg -i cloudflared.deb || true
        cloudflared tunnel --url http://localhost:6080 --no-autoupdate > tunnel.log 2>&1 &
        sleep 30
    - name: Get Tunnel URL
      run: |
        for i in \$(seq 1 30); do
          URL=\$(grep -oE 'https://[a-zA-Z0-9-]+\\.trycloudflare\\.com' tunnel.log | head -1)
          if [ -n "\$URL" ]; then
            echo "\$URL/vnc.html|__PASSWORD__" > info.txt
            echo "Found URL: \$URL"
            break
          fi
          sleep 2
        done
        if [ ! -f info.txt ]; then
          echo "ERROR|Tunnel not found" > info.txt
          cat tunnel.log
        fi
    - uses: actions/upload-artifact@v4
      with:
        name: result
        path: info.txt
    - name: Keep Alive
      run: sleep __DURATION__m`,

  win_web: `name: Windows NoVNC
on:
  workflow_dispatch:
concurrency:
  group: vps-\${{ github.repository }}
  cancel-in-progress: true
jobs:
  build:
    runs-on: windows-latest
    timeout-minutes: __TIMEOUT__
    steps:
    - uses: actions/checkout@v4
    - name: Install Software
      shell: cmd
      run: choco install googlechrome 7zip -y --no-progress --ignore-checksums
    - name: Set Password
      shell: pwsh
      run: |
        \$pw = ConvertTo-SecureString "__PASSWORD__" -AsPlainText -Force
        Set-LocalUser -Name "codecloud" -Password \$pw -ErrorAction SilentlyContinue
        if (!\$?) {
          New-LocalUser -Name "codecloud" -Password \$pw -FullName "CodeCloud" -Description "VPS User" -ErrorAction SilentlyContinue
          Add-LocalGroupMember -Group "Administrators" -Member "codecloud" -ErrorAction SilentlyContinue
        }
        Set-LocalUser -Name "runneradmin" -Password \$pw -ErrorAction SilentlyContinue
        Write-Host "Password set successfully for codecloud"
    - name: Install TightVNC
      shell: cmd
      run: |
        echo Downloading TightVNC...
        curl -L -o vnc.msi https://www.tightvnc.com/download/2.8.63/tightvnc-2.8.63-gpl-setup-64bit.msi
        echo Installing TightVNC...
        msiexec /i vnc.msi /quiet /norestart ADDLOCAL=Server SERVER_REGISTER_AS_SERVICE=1 SERVER_ADD_FIREWALL_EXCEPTION=1 SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=1 SET_PASSWORD=1 VALUE_OF_PASSWORD=__PASSWORD__ SET_ALLOWLOOPBACK=1 VALUE_OF_ALLOWLOOPBACK=1
        timeout /t 15 /nobreak
        net stop tvnserver
        timeout /t 3 /nobreak
        net start tvnserver
        timeout /t 5 /nobreak
    - name: Setup Websockify
      shell: pwsh
      run: |
        pip install websockify -q
        Invoke-WebRequest -Uri "https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.zip" -OutFile "novnc.zip" -UseBasicParsing
        Expand-Archive novnc.zip -DestinationPath . -Force
        if (Test-Path "noVNC-1.5.0") { Rename-Item "noVNC-1.5.0" "noVNC" -Force }
        Start-Process python -ArgumentList "-m","websockify","--web","noVNC","6080","127.0.0.1:5900" -WindowStyle Hidden
        Start-Sleep -Seconds 5
    - name: Start Tunnel
      shell: pwsh
      run: |
        Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "cf.exe" -UseBasicParsing
        Start-Process .\\cf.exe -ArgumentList "tunnel","--url","http://localhost:6080","--logfile","cf.log" -WindowStyle Hidden
        Start-Sleep -Seconds 45
        \$url = ""
        for (\$i = 0; \$i -lt 30; \$i++) {
          if (Test-Path cf.log) {
            \$content = Get-Content cf.log -Raw -ErrorAction SilentlyContinue
            \$match = [regex]::Match(\$content, 'https://[a-zA-Z0-9-]+\\.trycloudflare\\.com')
            if (\$match.Success) {
              \$url = \$match.Value
              break
            }
          }
          Start-Sleep 2
        }
        if (\$url) {
          "\$url/vnc.html|__PASSWORD__" | Out-File info.txt -NoNewline -Encoding UTF8
        } else {
          "ERROR|Tunnel not found" | Out-File info.txt -NoNewline -Encoding UTF8
        }
    - uses: actions/upload-artifact@v4
      with:
        name: result
        path: info.txt
    - name: Keep Alive
      shell: pwsh
      run: Start-Sleep -Seconds (__DURATION__ * 60)`,

  win_rdp: `name: Windows RDP
on:
  workflow_dispatch:
concurrency:
  group: vps-\${{ github.repository }}
  cancel-in-progress: true
jobs:
  build:
    runs-on: windows-latest
    timeout-minutes: __TIMEOUT__
    steps:
    - uses: actions/checkout@v4
    - name: Install Software
      shell: cmd
      run: choco install googlechrome 7zip -y --no-progress --ignore-checksums
    - name: Set Password
      shell: pwsh
      run: |
        \$pw = ConvertTo-SecureString "__PASSWORD__" -AsPlainText -Force
        Set-LocalUser -Name "codecloud" -Password \$pw -ErrorAction SilentlyContinue
        if (!\$?) {
          New-LocalUser -Name "codecloud" -Password \$pw -FullName "CodeCloud" -Description "VPS User" -ErrorAction SilentlyContinue
          Add-LocalGroupMember -Group "Administrators" -Member "codecloud" -ErrorAction SilentlyContinue
        }
        Set-LocalUser -Name "runneradmin" -Password \$pw -ErrorAction SilentlyContinue
    - name: Enable RDP
      shell: pwsh
      run: |
        Set-ItemProperty 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name "fDenyTSConnections" -Value 0
        Enable-NetFirewallRule -DisplayGroup "Remote Desktop"
    - name: Setup Ngrok
      shell: pwsh
      run: |
        Invoke-WebRequest https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip -OutFile ngrok.zip
        Expand-Archive ngrok.zip -Force
        .\\ngrok\\ngrok.exe config add-authtoken "__NGROK_TOKEN__"
        Start-Process .\\ngrok\\ngrok.exe -ArgumentList "tcp","--region","__NGROK_REGION__","3389" -WindowStyle Hidden
        Start-Sleep 20
        \$url = ""
        for (\$i = 0; \$i -lt 30; \$i++) {
          try {
            \$t = Invoke-RestMethod http://localhost:4040/api/tunnels
            if (\$t.tunnels.Count -gt 0) { 
              \$url = \$t.tunnels[0].public_url -replace 'tcp://','' 
              break 
            }
          } catch {}
          Start-Sleep 2
        }
        if (\$url) { "\$url|__PASSWORD__" | Out-File info.txt -NoNewline }
        else { "ERROR|Ngrok tunnel not found" | Out-File info.txt -NoNewline }
    - uses: actions/upload-artifact@v4
      with:
        name: result
        path: info.txt
    - name: Keep Alive
      shell: pwsh
      run: Start-Sleep (__DURATION__ * 60)`,

  win_tailscale: `name: Windows Tailscale
on:
  workflow_dispatch:
concurrency:
  group: vps-\${{ github.repository }}
  cancel-in-progress: true
jobs:
  build:
    runs-on: windows-latest
    timeout-minutes: 395
    steps:
    - uses: actions/checkout@v4
    - name: Setup Users and RDP
      shell: pwsh
      run: |
        Write-Host "=== Setting up users ==="
        \$pw = ConvertTo-SecureString "__PASSWORD__" -AsPlainText -Force
        
        # Create codecloud user
        try {
          New-LocalUser -Name "codecloud" -Password \$pw -FullName "CodeCloud" -Description "VPS User" -PasswordNeverExpires -ErrorAction Stop
          Write-Host "Created user: codecloud"
        } catch {
          Write-Host "User codecloud may exist, updating password..."
          Set-LocalUser -Name "codecloud" -Password \$pw -ErrorAction SilentlyContinue
        }
        
        # Add to groups
        Add-LocalGroupMember -Group "Administrators" -Member "codecloud" -ErrorAction SilentlyContinue
        Add-LocalGroupMember -Group "Remote Desktop Users" -Member "codecloud" -ErrorAction SilentlyContinue
        
        # Update runneradmin password
        Set-LocalUser -Name "runneradmin" -Password \$pw -ErrorAction SilentlyContinue
        Add-LocalGroupMember -Group "Remote Desktop Users" -Member "runneradmin" -ErrorAction SilentlyContinue
        
        Write-Host "=== Enabling RDP ==="
        # Enable RDP
        Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name "fDenyTSConnections" -Value 0 -Force
        Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp' -Name "UserAuthentication" -Value 0 -Force
        
        # Disable NLA (Network Level Authentication) for easier connection
        Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp' -Name "SecurityLayer" -Value 0 -Force
        
        Write-Host "=== Configuring Firewall ==="
        # Enable all RDP firewall rules
        Enable-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue
        
        # Add explicit firewall rules for port 3389 on ALL profiles (including Tailscale)
        New-NetFirewallRule -DisplayName "RDP-TCP-All" -Direction Inbound -Protocol TCP -LocalPort 3389 -Action Allow -Profile Any -ErrorAction SilentlyContinue
        New-NetFirewallRule -DisplayName "RDP-UDP-All" -Direction Inbound -Protocol UDP -LocalPort 3389 -Action Allow -Profile Any -ErrorAction SilentlyContinue
        
        # Allow ICMP for ping testing
        New-NetFirewallRule -DisplayName "Allow ICMPv4" -Direction Inbound -Protocol ICMPv4 -Action Allow -Profile Any -ErrorAction SilentlyContinue
        
        # Restart RDP service
        Restart-Service -Name "TermService" -Force -ErrorAction SilentlyContinue
        
        Write-Host "=== RDP Setup Complete ==="
        
    - name: Install Tailscale
      shell: pwsh
      run: |
        Write-Host "=== Downloading Tailscale ==="
        Invoke-WebRequest -Uri "https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi" -OutFile "tailscale.msi" -UseBasicParsing
        
        Write-Host "=== Installing Tailscale ==="
        \$process = Start-Process msiexec.exe -ArgumentList '/i', 'tailscale.msi', '/quiet', '/norestart' -Wait -PassThru
        Write-Host "Installer exit code: \$(\$process.ExitCode)"
        
        Start-Sleep -Seconds 20
        
        \$tsPath = "C:\\Program Files\\Tailscale\\tailscale.exe"
        if (Test-Path \$tsPath) {
          Write-Host "Tailscale installed successfully at: \$tsPath"
          # Also start the Tailscale service
          Start-Service -Name "Tailscale" -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 5
        } else {
          Write-Host "ERROR: Tailscale not found!"
          Get-ChildItem "C:\\Program Files\\" -ErrorAction SilentlyContinue | ForEach-Object { Write-Host \$_.Name }
          "ERROR|Tailscale installation failed" | Out-File info.txt -NoNewline -Encoding UTF8
          exit 0
        }
        
    - name: Start Tailscale and Get IP
      shell: pwsh
      run: |
        \$tsPath = "C:\\Program Files\\Tailscale\\tailscale.exe"
        
        if (!(Test-Path \$tsPath)) {
          Write-Host "Tailscale not installed!"
          "ERROR|Tailscale not installed" | Out-File info.txt -NoNewline -Encoding UTF8
          exit 0
        }
        
        Write-Host "=== Starting Tailscale ==="
        
        # Start Tailscale with proper flags
        # --hostname: Set the machine name in Tailscale
        # --accept-routes: Accept routes from other nodes
        # --accept-dns: Use Tailscale DNS
        & \$tsPath up --hostname=gh-vps-rdp --accept-routes --accept-dns 2>&1 | Write-Host
        
        Start-Sleep -Seconds 10
        
        Write-Host "=== Waiting for Tailscale connection ==="
        \$found = \$false
        \$authUrlShown = \$false
        
        for (\$i = 0; \$i -lt 90; \$i++) {
          Start-Sleep -Seconds 3
          
          # Check for IP first
          try {
            \$ipResult = & \$tsPath ip -4 2>&1 | Out-String
            Write-Host "Attempt \$i - IP check: \$ipResult"
            
            if (\$ipResult -match '100\\.\\d+\\.\\d+\\.\\d+') {
              \$ip = \$Matches[0]
              Write-Host "SUCCESS! Got Tailscale IP: \$ip"
              
              # Verify RDP is listening
              \$rdpCheck = Get-NetTCPConnection -LocalPort 3389 -ErrorAction SilentlyContinue
              if (\$rdpCheck) {
                Write-Host "RDP is listening on port 3389"
              } else {
                Write-Host "Warning: RDP may not be listening, restarting service..."
                Restart-Service -Name "TermService" -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 3
              }
              
              # Output the connection info (IP without port - RDP default is 3389)
              "\${ip}:3389|__PASSWORD__" | Out-File info.txt -NoNewline -Encoding UTF8
              \$found = \$true
              break
            }
          } catch {
            Write-Host "IP check error: \$_"
          }
          
          # Check status for auth URL
          try {
            \$statusResult = & \$tsPath status 2>&1 | Out-String
            
            if (\$statusResult -match 'https://login\\.tailscale\\.com/a/[a-zA-Z0-9]+') {
              \$authUrl = \$Matches[0]
              Write-Host "Auth URL found: \$authUrl"
              
              if (!\$authUrlShown) {
                Write-Host "WAITING_AUTH: User needs to authenticate at \$authUrl"
                "WAITING_AUTH|\$authUrl" | Out-File info.txt -NoNewline -Encoding UTF8
                \$authUrlShown = \$true
              }
            }
          } catch {
            Write-Host "Status check error: \$_"
          }
          
          if (\$i % 10 -eq 0) {
            Write-Host "Still waiting... (\$i iterations)"
          }
        }
        
        if (!\$found) {
          Write-Host "Timeout waiting for Tailscale IP"
          if (!\$authUrlShown) {
            "PENDING|Waiting for Tailscale..." | Out-File info.txt -NoNewline -Encoding UTF8
          }
        }
        
    - name: Upload Initial Result
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: result
        path: info.txt
        overwrite: true
        
    - name: Wait for Auth and Update IP
      if: always()
      shell: pwsh
      run: |
        \$tsPath = "C:\\Program Files\\Tailscale\\tailscale.exe"
        
        if (!(Test-Path \$tsPath)) {
          Write-Host "Tailscale not installed, skipping..."
          exit 0
        }
        
        # Check if we already have IP
        if (Test-Path info.txt) {
          \$content = Get-Content info.txt -Raw
          if (\$content -match '^100\\.') {
            Write-Host "Already have IP, skipping wait loop"
            exit 0
          }
        }
        
        Write-Host "=== Waiting for Tailscale authentication ==="
        
        for (\$i = 0; \$i -lt 180; \$i++) {
          Start-Sleep -Seconds 5
          
          try {
            \$ipResult = & \$tsPath ip -4 2>&1 | Out-String
            
            if (\$ipResult -match '100\\.\\d+\\.\\d+\\.\\d+') {
              \$ip = \$Matches[0]
              Write-Host "Authenticated! Got IP: \$ip"
              
              # Verify RDP
              \$rdpCheck = Get-NetTCPConnection -LocalPort 3389 -ErrorAction SilentlyContinue
              if (!\$rdpCheck) {
                Write-Host "Restarting RDP service..."
                Restart-Service -Name "TermService" -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 3
              }
              
              # Update info.txt with final IP
              "\${ip}:3389|__PASSWORD__" | Out-File info.txt -NoNewline -Encoding UTF8
              Write-Host "Updated info.txt with IP: \${ip}:3389"
              break
            }
          } catch {
            Write-Host "Check error: \$_"
          }
          
          if (\$i % 12 -eq 0) {
            Write-Host "Still waiting for auth... (\$(\$i * 5)s elapsed)"
            # Show status for debugging
            try {
              \$status = & \$tsPath status 2>&1 | Out-String
              Write-Host "Status: \$status"
            } catch {}
          }
        }
        
    - name: Upload Final Result
      uses: actions/upload-artifact@v4
      if: always()
      with:
        name: result
        path: info.txt
        overwrite: true
        
    - name: Keep Alive
      if: always()
      shell: pwsh
      run: |
        Write-Host "=== Session Info ==="
        Write-Host "Keeping session alive for 6 hours..."
        Write-Host "Users available: runneradmin, codecloud"
        Write-Host "Password: __PASSWORD__"
        
        # Show final status
        \$tsPath = "C:\\Program Files\\Tailscale\\tailscale.exe"
        if (Test-Path \$tsPath) {
          try {
            \$ip = & \$tsPath ip -4 2>&1 | Out-String
            Write-Host "Tailscale IP: \$ip"
            \$status = & \$tsPath status 2>&1 | Out-String
            Write-Host "Tailscale Status: \$status"
          } catch {}
        }
        
        # Show RDP status
        \$rdp = Get-NetTCPConnection -LocalPort 3389 -ErrorAction SilentlyContinue
        if (\$rdp) {
          Write-Host "RDP is listening on port 3389"
        }
        
        # Keep alive
        Start-Sleep -Seconds 21600`
};

const PLAN_NAMES = {
  ubuntu_web: "Ubuntu Desktop",
  win_web: "Windows Web",
  win_rdp: "Windows RDP",
  win_tailscale: "Windows Tailscale"
};

const SPECS = {
  private: { cores: 2, ram: "7 GB", label: "Private" },
  public: { cores: 4, ram: "16 GB", label: "Public" }
};

function randomPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let password = "Vps@";
  for (let i = 0; i < 8; i++) {
    password += chars[Math.floor(Math.random() * chars.length)];
  }
  return password + Math.floor(Math.random() * 10);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidRepoName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length < 1 || name.length > 100) return false;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return false;
  if (/\.\.|--/.test(name)) return false;
  return true;
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
  } catch (e) { console.error('Upstash error:', e); return null; }
}

async function ghFetch(url, method, token, body, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const opts = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "CodeCloud-VPS/1.0"
        }
      };
      if (body) opts.body = JSON.stringify(body);
      
      const res = await fetch(url, opts);
      const text = await res.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      
      return { status: res.status, data: json };
    } catch (err) {
      if (attempt < retries - 1) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      return { status: 0, data: {}, error: err.message };
    }
  }
  return { status: 0, data: {}, error: "Max retries reached" };
}

async function waitForWorkflowStart(repoPath, token, timeoutMs = 60000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const runs = await ghFetch(
      `https://api.github.com/repos/${repoPath}/actions/runs?per_page=1`,
      "GET",
      token
    );
    
    if (runs.status === 200 && runs.data.workflow_runs?.length > 0) {
      const run = runs.data.workflow_runs[0];
      const createdAt = new Date(run.created_at).getTime();
      if (Date.now() - createdAt < 120000) {
        return { success: true, run };
      }
    }
    
    await sleep(5000);
  }
  
  return { success: false, error: 'Workflow không khởi động trong 60 giây' };
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.connection?.remoteAddress || 'unknown';
}

// Get a live token from the pool (round-robin style)
async function getLiveToken() {
  const ids = await upstash('LRANGE', 'gh_tokens', '0', '-1');
  if (!ids || ids.length === 0) return null;
  
  // Try to get last used index for round-robin
  let lastIdx = parseInt(await upstash('GET', 'gh_token_last_idx') || '0');
  
  // Try each token starting from lastIdx
  for (let i = 0; i < ids.length; i++) {
    const idx = (lastIdx + i) % ids.length;
    const id = ids[idx];
    const raw = await upstash('GET', `gh_token:${id}`);
    if (!raw) continue;
    
    try {
      const parsed = JSON.parse(raw);
      const meta = parsed.meta || {};
      if (meta.status === 'live' && parsed.token) {
        // Update last used index
        await upstash('SET', 'gh_token_last_idx', String((idx + 1) % ids.length));
        return { id, token: parsed.token, owner: meta.owner };
      }
    } catch (e) { continue; }
  }
  return null;
}

// Save active VPS for auto-cleanup
async function saveActiveVps(data) {
  const { owner, repo, tokenId, durationMinutes, createdAt } = data;
  const expiresAt = new Date(new Date(createdAt).getTime() + durationMinutes * 60 * 1000).toISOString();
  
  const vpsData = {
    owner,
    repo,
    tokenId,
    durationMinutes,
    createdAt,
    expiresAt
  };
  
  const key = `active_vps:${owner}:${repo}`;
  await upstash('SET', key, JSON.stringify(vpsData));
  await upstash('SADD', 'active_vps_keys', key);
  
  console.log(`[VPS] Saved active VPS: ${owner}/${repo}, expires at ${expiresAt}`);
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    const { planId, durationMinutes, repoName, ngrokToken, repoVisibility, ngrokRegion } = body;

    console.log("[VPS] Request:", { planId, repoName, visibility: repoVisibility });

    // ALWAYS get token from pool - users don't provide tokens anymore
    const tokenData = await getLiveToken();
    if (!tokenData) {
      return res.status(500).json({ 
        success: false, 
        message: 'Không có GitHub Token khả dụng. Admin cần thêm token trong Admin Panel.',
        code: 'NO_TOKEN'
      });
    }
    
    const githubToken = tokenData.token;
    const usedTokenId = tokenData.id;
    const tokenOwner = tokenData.owner;
    
    console.log(`[VPS] Using token: ${usedTokenId} (owner: ${tokenOwner})`);
    
    if (!repoName || typeof repoName !== "string") {
      return res.status(400).json({ success: false, message: "Thiếu tên Repository" });
    }
    if (!isValidRepoName(repoName)) {
      return res.status(400).json({ 
        success: false, 
        message: "Tên Repository không hợp lệ. Chỉ dùng chữ, số, gạch ngang, gạch dưới." 
      });
    }
    if (!planId || !YAML_TEMPLATES[planId]) {
      return res.status(400).json({ success: false, message: "Plan không hợp lệ" });
    }
    if (planId === "win_rdp" && !ngrokToken) {
      return res.status(400).json({ success: false, message: "Windows RDP cần Ngrok Token" });
    }

    console.log("[VPS] Verifying token...");
    const userRes = await ghFetch("https://api.github.com/user", "GET", githubToken);
    if (userRes.status !== 200 || !userRes.data?.login) {
      // Mark token as dead
      const raw = await upstash('GET', `gh_token:${usedTokenId}`);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          parsed.meta = parsed.meta || {};
          parsed.meta.status = 'dead';
          parsed.meta.lastChecked = new Date().toISOString();
          await upstash('SET', `gh_token:${usedTokenId}`, JSON.stringify(parsed));
        } catch(e) {}
      }
      return res.status(500).json({ 
        success: false, 
        message: "GitHub Token trong pool đã hết hạn. Admin cần kiểm tra token.",
        code: 'TOKEN_EXPIRED'
      });
    }
    const login = userRes.data.login;
    console.log("[VPS] User:", login);

    const password = randomPassword();
    const duration = planId === "win_tailscale" ? 360 : Math.max(1, Math.min(360, parseInt(durationMinutes) || 60));
    const timeout = duration + 25;
    const isPrivate = repoVisibility === "private";
    const specs = isPrivate ? SPECS.private : SPECS.public;

    console.log("[VPS] Checking existing repo...");
    const checkRes = await ghFetch(`https://api.github.com/repos/${login}/${repoName}`, "GET", githubToken);
    if (checkRes.status === 200) {
      console.log("[VPS] Deleting existing repo...");
      await ghFetch(`https://api.github.com/repos/${login}/${repoName}`, "DELETE", githubToken);
      await sleep(3000);
    }

    console.log("[VPS] Creating repo...");
    const createRes = await ghFetch("https://api.github.com/user/repos", "POST", githubToken, {
      name: repoName,
      description: `VPS ${PLAN_NAMES[planId]} - CodeCloud`,
      private: isPrivate,
      auto_init: true,
      has_issues: false,
      has_projects: false,
      has_wiki: false
    });

    if (createRes.status !== 201) {
      console.log("[VPS] Create failed:", createRes.status, createRes.data);
      return res.status(500).json({ 
        success: false, 
        message: `Không thể tạo repo: ${createRes.data?.message || "Unknown error"}`,
        detail: createRes.data
      });
    }
    console.log("[VPS] Repo created successfully");

    await sleep(3000);

    await ghFetch(`https://api.github.com/repos/${login}/${repoName}/actions/permissions`, "PUT", githubToken, {
      enabled: true,
      allowed_actions: "all"
    });

    let yml = YAML_TEMPLATES[planId]
      .replace(/__PASSWORD__/g, password)
      .replace(/__DURATION__/g, String(duration))
      .replace(/__TIMEOUT__/g, String(timeout));

    if (planId === "win_rdp" && ngrokToken) {
      yml = yml.replace(/__NGROK_TOKEN__/g, ngrokToken);
      yml = yml.replace(/__NGROK_REGION__/g, ngrokRegion || "ap");
    }

    const content = Buffer.from(yml, "utf8").toString("base64");

    console.log("[VPS] Pushing workflow...");
    let pushOk = false;
    let pushError = null;
    
    for (let i = 0; i < 5; i++) {
      await sleep(2000);
      
      const pushRes = await ghFetch(
        `https://api.github.com/repos/${login}/${repoName}/contents/.github/workflows/run.yml`,
        "PUT",
        githubToken,
        { message: "Add VPS workflow", content, branch: "main" }
      );
      
      if (pushRes.status === 201 || pushRes.status === 200) {
        pushOk = true;
        console.log("[VPS] Workflow pushed successfully");
        break;
      }
      
      pushError = pushRes.data?.message || `HTTP ${pushRes.status}`;
    }

    if (!pushOk) {
      return res.status(500).json({ success: false, message: `Không thể tạo workflow: ${pushError}` });
    }

    await sleep(3000);

    console.log("[VPS] Dispatching workflow...");
    let dispatched = false;
    let dispatchError = null;
    
    for (let i = 0; i < 7; i++) {
      await sleep(2000);
      
      const dispatchRes = await ghFetch(
        `https://api.github.com/repos/${login}/${repoName}/actions/workflows/run.yml/dispatches`,
        "POST",
        githubToken,
        { ref: "main" }
      );
      
      if (dispatchRes.status === 204) {
        dispatched = true;
        console.log("[VPS] Workflow dispatched successfully");
        break;
      }
      
      dispatchError = dispatchRes.data?.message || `HTTP ${dispatchRes.status}`;
    }

    if (dispatched) {
      console.log("[VPS] Waiting for workflow to start...");
      const repoPath = `${login}/${repoName}`;
      const startResult = await waitForWorkflowStart(repoPath, githubToken, 60000);
      
      if (!startResult.success) {
        console.log("[VPS] Workflow failed to start within 60s");
        return res.status(500).json({
          success: false,
          message: `Workflow không khởi động trong 60 giây. Vui lòng thử lại.`,
          timeout: true,
          repoUrl: `https://github.com/${repoPath}`,
          actionsUrl: `https://github.com/${repoPath}/actions`
        });
      }
      
      console.log("[VPS] Workflow started:", startResult.run.id);
    }

    const repoUrl = `https://github.com/${login}/${repoName}`;
    const actionsUrl = `${repoUrl}/actions`;
    const createdAt = new Date().toISOString();

    console.log("[VPS] Complete! dispatched=", dispatched);

    // Save active VPS for auto-cleanup
    try {
      await saveActiveVps({
        owner: login,
        repo: repoName,
        tokenId: usedTokenId,
        durationMinutes: duration,
        createdAt
      });
    } catch (e) {
      console.error('[VPS] Failed to save active VPS:', e);
    }

    // Deduct time from the user's balance server-side
    try {
      const username = body.username;
      if (username) {
        const timeKey = `time:${username}`;
        const raw = await upstash('GET', timeKey);
        const previousMinutes = raw ? parseInt(raw) || 0 : 0;
        const newMinutes = Math.max(0, previousMinutes - duration);
        await upstash('SET', timeKey, String(newMinutes));
        
        const clientIP = getClientIP(req);
        const logEntry = {
          type: 'updateTime',
          username: username,
          ip: clientIP,
          at: new Date().toISOString(),
          operation: 'deduct',
          minutes: duration,
          previousMinutes,
          newMinutes,
          repo: `${login}/${repoName}`
        };
        await upstash('LPUSH', 'userlogs', JSON.stringify(logEntry));
        await upstash('LTRIM', 'userlogs', '0', '499');
        console.log(`[VPS] Deducted ${duration}m from ${username} (was ${previousMinutes} -> now ${newMinutes})`);
      }
    } catch (e) {
      console.error('[VPS] Failed to deduct time:', e);
    }

    // Log deployment
    try {
      const clientIP = getClientIP(req);
      const deployLog = {
        type: 'vps_created',
        createdAt,
        githubLogin: login,
        username: body.username || login,
        durationMinutes: duration,
        repo: `${login}/${repoName}`,
        repoUrl,
        actionsUrl,
        vpsPassword: password,
        clientIP,
        ipRaw: req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || null,
        ua: req.headers['user-agent'] || null,
        tokenId: usedTokenId,
        tokenOwner: login
      };
      await upstash('LPUSH', 'userlogs', JSON.stringify(deployLog));
      await upstash('LTRIM', 'userlogs', '0', '499');
    } catch (e) { console.error('Failed to log deployment:', e); }

    return res.status(200).json({
      success: true,
      pending: true,
      dispatched,
      message: dispatched 
        ? "Workflow đã kích hoạt thành công!" 
        : `Workflow đã tạo nhưng chưa kích hoạt được (${dispatchError}). Vào Actions để kích hoạt thủ công.`,
      vpsPassword: password,
      repoUrl,
      actionsUrl,
      planId,
      planName: PLAN_NAMES[planId],
      duration,
      specs,
      repoVisibility: isPrivate ? "private" : "public",
      owner: login,
      startedAt: createdAt,
      requiresTailscaleAuth: planId === "win_tailscale"
    });

  } catch (err) {
    console.error("[VPS] Unhandled error:", err);
    return res.status(500).json({
      success: false,
      message: "Lỗi server: " + (err.message || String(err))
    });
  }
};
