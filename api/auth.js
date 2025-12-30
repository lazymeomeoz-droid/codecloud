// API for user authentication - Vercel Serverless Function
// Using Upstash Redis for persistent storage

const FREE_TIME_FOR_NEW_USER = 30;

// Admin accounts (hardcoded)
const ADMIN_ACCOUNTS = [
  { username: 'vanmanh', password: 'vanmanh' },
  { username: 'depchai', password: 'depchai' }
];

// Upstash Redis REST API
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// =====================================================
// REDIS HELPERS
// =====================================================

async function redis(command, ...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error('Upstash Redis not configured!');
    return null;
  }
  
  try {
    const res = await fetch(`${UPSTASH_URL}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([command, ...args])
    });
    
    const data = await res.json();
    return data.result;
  } catch (e) {
    console.error('Redis error:', e.message);
    return null;
  }
}

// Log event helper (push to list 'userlogs')
async function logEvent(evt) {
  try {
    await redis('LPUSH', 'userlogs', JSON.stringify(evt));
  } catch (e) {
    console.error('logEvent error:', e && e.message);
  }
}

async function getUser(username) {
  const data = await redis('GET', `user:${username}`);
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

async function saveUser(username, userData) {
  return await redis('SET', `user:${username}`, JSON.stringify(userData));
}

async function getTime(username) {
  const data = await redis('GET', `time:${username}`);
  return data ? parseInt(data) || 0 : 0;
}

async function saveTime(username, minutes) {
  return await redis('SET', `time:${username}`, String(minutes));
}

async function getIpRegistry(ip) {
  const data = await redis('GET', `ip:${ip}`);
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

async function saveIpRegistry(ip, registryData) {
  return await redis('SET', `ip:${ip}`, JSON.stringify(registryData));
}

async function getAllUsers() {
  // Get all user keys
  const keys = await redis('KEYS', 'user:*');
  if (!keys || keys.length === 0) return [];
  
  const users = [];
  for (const key of keys) {
    const username = key.replace('user:', '');
    const userData = await getUser(username);
    if (userData) {
      const timeMinutes = await getTime(username);
      users.push({ ...userData, timeMinutes });
    }
  }
  return users;
}

// =====================================================
// UTILITY FUNCTIONS
// =====================================================

function hashPassword(password) {
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'h_' + Math.abs(hash).toString(16);
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'] || req.headers['x-forwarded'] || '';
  const cf = req.headers['cf-connecting-ip'] || null;

  // Helper: check private/local ranges
  function isPrivate(ip) {
    if (!ip || ip === 'unknown') return true;
    // IPv6 localhost or unique local
    if (ip.startsWith('::1') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
    // IPv4 private ranges
    const parts = ip.split(':')[0].split('.');
    if (parts.length === 4) {
      const a = parseInt(parts[0] || 0, 10);
      const b = parseInt(parts[1] || 0, 10);
      if (a === 10) return true;
      if (a === 127) return true;
      if (a === 192 && b === 168) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
    }
    return false;
  }

  // Prefer CF header if present (Cloudflare provides original IP)
  if (cf) return cf;

  if (forwarded) {
    // X-Forwarded-For may contain a list: client, proxy1, proxy2
    const list = forwarded.split(',').map(s => s.trim()).filter(Boolean);
    for (const ip of list) {
      if (!isPrivate(ip)) return ip;
    }
    // fallback to first if all private
    if (list.length > 0) return list[0];
  }

  return req.headers['x-real-ip'] || req.connection?.remoteAddress || 'unknown';
}

function checkBanStatus(user) {
  if (!user || !user.isBanned) return false;
  
  if (user.banType === 'permanent') return true;
  
  if (user.banUntil) {
    const banUntilDate = new Date(user.banUntil);
    if (banUntilDate <= new Date()) {
      return false; // Ban expired
    }
    return true;
  }
  
  return true;
}

// =====================================================
// MAIN HANDLER
// =====================================================

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  // Check Redis config
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ 
      success: false, 
      message: 'Server chưa cấu hình database. Admin cần thêm UPSTASH_REDIS_REST_URL và UPSTASH_REDIS_REST_TOKEN vào Vercel Environment Variables.' 
    });
  }

  try {
    const clientIP = getClientIP(req);
    const body = req.body || {};
    const { action, username, password, confirmPassword, minutes, operation, banDuration, banUnit, targetUsername } = body;

    if (!action) {
      return res.status(400).json({ success: false, message: 'Missing action' });
    }

    const usernameLower = (username || targetUsername || '').trim().toLowerCase();

    // === LOGIN ===
    if (action === 'login') {
      if (!usernameLower || !password) {
        return res.status(400).json({ success: false, message: 'Thiếu thông tin đăng nhập' });
      }

      // Check admin accounts first
      const adminAccount = ADMIN_ACCOUNTS.find(
        a => a.username === usernameLower && a.password === password
      );
      
      if (adminAccount) {
          // log admin login (include raw forwarding and user-agent for verification)
          try {
            await logEvent({
              type: 'admin_login',
              username: adminAccount.username,
              ip: clientIP,
              ipRaw: req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || null,
              ua: req.headers['user-agent'] || null,
              at: new Date().toISOString()
            });
          } catch(e){}
        return res.json({
          success: true,
          user: {
            username: adminAccount.username,
            isAdmin: true,
            createdAt: new Date().toISOString()
          },
          timeMinutes: 9999
        });
      }

      // Check regular user
      const user = await getUser(usernameLower);

      if (!user) {
        return res.status(401).json({ success: false, message: 'Tài khoản không tồn tại' });
      }

      if (user.passwordHash !== hashPassword(password)) {
        return res.status(401).json({ success: false, message: 'Mật khẩu không đúng' });
      }

      // Check ban status
      const isBanned = checkBanStatus(user);
      if (isBanned) {
        let banMsg = 'Tài khoản đã bị khóa';
        if (user.banType === 'permanent') {
          banMsg = 'Tài khoản đã bị khóa vĩnh viễn';
        } else if (user.banUntil) {
          const remaining = new Date(user.banUntil) - new Date();
          const hours = Math.ceil(remaining / (1000 * 60 * 60));
          banMsg = `Tài khoản bị khóa. Còn ${hours > 24 ? Math.ceil(hours/24) + ' ngày' : hours + ' giờ'}`;
        }
        return res.status(403).json({ success: false, message: banMsg });
      } else if (user.isBanned) {
        // Auto-unban expired
        user.isBanned = false;
        user.banType = null;
        user.banUntil = null;
        user.banReason = null;
        await saveUser(usernameLower, user);
      }

      // Update last login
      user.lastLoginIP = clientIP;
      user.lastLoginAt = new Date().toISOString();
      await saveUser(usernameLower, user);

      // log login (include raw forwarding header and user-agent)
      try {
        await logEvent({
          type: 'login',
          username: user.username,
          ip: clientIP,
          ipRaw: req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || null,
          ua: req.headers['user-agent'] || null,
          at: new Date().toISOString()
        });
      } catch(e) {}

      // Get user time
      const timeMinutes = await getTime(usernameLower);

      return res.json({
        success: true,
        user: {
          username: user.username,
          createdAt: user.createdAt,
          isAdmin: false
        },
        timeMinutes
      });
    }

    // === REGISTER ===
    if (action === 'register') {
      if (!usernameLower || !password) {
        return res.status(400).json({ success: false, message: 'Thiếu thông tin đăng ký' });
      }

      if (usernameLower.length < 3 || usernameLower.length > 20) {
        return res.status(400).json({ success: false, message: 'Tên đăng nhập phải từ 3-20 ký tự' });
      }

      if (!/^[a-z0-9_]+$/.test(usernameLower)) {
        return res.status(400).json({ success: false, message: 'Tên đăng nhập chỉ được chứa chữ thường, số và gạch dưới' });
      }

      if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Mật khẩu phải từ 6 ký tự trở lên' });
      }

      if (confirmPassword && password !== confirmPassword) {
        return res.status(400).json({ success: false, message: 'Mật khẩu xác nhận không khớp' });
      }

      // Check admin username
      if (ADMIN_ACCOUNTS.some(a => a.username === usernameLower)) {
        return res.status(400).json({ success: false, message: 'Tên đăng nhập đã tồn tại' });
      }

      // Check if username exists
      const existingUser = await getUser(usernameLower);
      if (existingUser) {
        return res.status(400).json({ success: false, message: 'Tên đăng nhập đã tồn tại' });
      }

      // Check IP for multi-account
      let isBanned = false;
      let existingUsername = null;
      const ipRegistry = await getIpRegistry(clientIP);
      
      if (ipRegistry) {
        // IP already has an account
        existingUsername = ipRegistry.firstUsername;
        isBanned = true;
        
        // Update registry
        ipRegistry.allUsernames = ipRegistry.allUsernames || [];
        if (!ipRegistry.allUsernames.includes(usernameLower)) {
          ipRegistry.allUsernames.push(usernameLower);
        }
        ipRegistry.accountCount = (ipRegistry.accountCount || 1) + 1;
        ipRegistry.lastActivity = new Date().toISOString();
        await saveIpRegistry(clientIP, ipRegistry);
      } else {
        // New IP
        await saveIpRegistry(clientIP, {
          firstUsername: usernameLower,
          allUsernames: [usernameLower],
          accountCount: 1,
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString()
        });
      }

      // Create user
      const newUser = {
        username: usernameLower,
        passwordHash: hashPassword(password),
        registerIP: clientIP,
        createdAt: new Date().toISOString(),
        isBanned: isBanned,
        banType: isBanned ? 'permanent' : null,
        banReason: isBanned ? `Tài khoản phụ (IP trùng với ${existingUsername})` : null
      };
      
      await saveUser(usernameLower, newUser);

      // Set initial time
      await saveTime(usernameLower, isBanned ? 0 : FREE_TIME_FOR_NEW_USER);

      // log registration (include raw forwarding header and user-agent)
      try {
        await logEvent({
          type: 'register',
          username: newUser.username,
          ip: clientIP,
          ipRaw: req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || null,
          ua: req.headers['user-agent'] || null,
          at: new Date().toISOString(),
          banned: isBanned
        });
      } catch(e) {}

      if (isBanned) {
        return res.status(403).json({ 
          success: false, 
          message: `Phát hiện tài khoản phụ! IP của bạn đã đăng ký tài khoản "${existingUsername}". Tài khoản mới đã bị khóa.`
        });
      }

      return res.json({
        success: true,
        user: {
          username: newUser.username,
          createdAt: newUser.createdAt,
          isAdmin: false
        },
        timeMinutes: FREE_TIME_FOR_NEW_USER
      });
    }

    // === GET TIME ===
    if (action === 'getTime') {
      if (!usernameLower) {
        return res.status(400).json({ success: false, message: 'Missing username' });
      }
      const minutes = await getTime(usernameLower);
      return res.json({ success: true, minutes });
    }

    // === UPDATE TIME ===
    if (action === 'updateTime') {
      if (!usernameLower) {
        return res.status(400).json({ success: false, message: 'Missing username' });
      }
      if (typeof minutes !== 'number') {
        return res.status(400).json({ success: false, message: 'Invalid minutes' });
      }

      // verify user exists
      const targetUser = await getUser(usernameLower);
      if (!targetUser) {
        return res.status(404).json({ success: false, message: 'User không tồn tại' });
      }

      const previousMinutes = await getTime(usernameLower);
      let newMinutes;

      switch (operation) {
        case 'add':
          newMinutes = previousMinutes + minutes;
          break;
        case 'deduct':
          newMinutes = Math.max(0, previousMinutes - minutes);
          break;
        default: // 'set'
          newMinutes = Math.max(0, minutes);
      }

      await saveTime(usernameLower, newMinutes);

      // log time update (include forwarding and ua)
      try {
        await logEvent({
          type: 'updateTime',
          username: usernameLower,
          ip: clientIP,
          ipRaw: req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || null,
          ua: req.headers['user-agent'] || null,
          at: new Date().toISOString(),
          operation,
          minutes,
          previousMinutes,
          newMinutes
        });
      } catch(e) {}

      return res.json({
        success: true,
        previousMinutes,
        newMinutes
      });
    }

    // === GET ALL USERS (Admin) ===
    if (action === 'getAllUsers') {
      const users = await getAllUsers();
      return res.json({
        success: true,
        users
      });
    }

    // === BAN USER (Admin) ===
    if (action === 'banUser') {
      if (!usernameLower) {
        return res.status(400).json({ success: false, message: 'Missing username' });
      }
      
      const user = await getUser(usernameLower);
      
      if (!user) {
        return res.status(404).json({ success: false, message: 'User không tồn tại' });
      }
      
      const duration = parseInt(banDuration) || 1;
      const unit = banUnit || 'permanent';
      
      let banUntil = null;
      if (unit !== 'permanent') {
        const now = new Date();
        switch (unit) {
          case 'hours':
            banUntil = new Date(now.getTime() + duration * 60 * 60 * 1000);
            break;
          case 'days':
            banUntil = new Date(now.getTime() + duration * 24 * 60 * 60 * 1000);
            break;
          case 'months':
            banUntil = new Date(now.getTime() + duration * 30 * 24 * 60 * 60 * 1000);
            break;
        }
      }
      
      const unitText = { hours: 'giờ', days: 'ngày', months: 'tháng', permanent: 'vĩnh viễn' }[unit] || unit;
      const reason = unit === 'permanent' 
        ? 'Khóa vĩnh viễn bởi Admin' 
        : `Khóa ${duration} ${unitText} bởi Admin`;
      
      user.isBanned = true;
      user.banType = unit;
      user.banUntil = banUntil ? banUntil.toISOString() : null;
      user.banReason = reason;
      user.bannedAt = new Date().toISOString();
      
      await saveUser(usernameLower, user);
      
      // log ban (include forwarded header + ua)
      try {
        await logEvent({
          type: 'ban',
          target: usernameLower,
          ip: clientIP,
          ipRaw: req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || null,
          ua: req.headers['user-agent'] || null,
          at: new Date().toISOString(),
          unit,
          duration,
          banUntil: banUntil ? banUntil.toISOString() : null,
          reason
        });
      } catch(e) {}

      return res.json({ 
        success: true, 
        message: `Đã ban user ${usernameLower}`,
        banUntil
      });
    }

    // === UNBAN USER (Admin) ===
    if (action === 'unbanUser') {
      if (!usernameLower) {
        return res.status(400).json({ success: false, message: 'Missing username' });
      }
      
      const user = await getUser(usernameLower);
      
      if (!user) {
        return res.status(404).json({ success: false, message: 'User không tồn tại' });
      }
      
      user.isBanned = false;
      user.banType = null;
      user.banUntil = null;
      user.banReason = null;
      
      await saveUser(usernameLower, user);

      // log unban (include forwarded header + ua)
      try {
        await logEvent({
          type: 'unban',
          target: usernameLower,
          ip: clientIP,
          ipRaw: req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || null,
          ua: req.headers['user-agent'] || null,
          at: new Date().toISOString()
        });
      } catch(e) {}
      
      return res.json({ success: true, message: `Đã unban user ${usernameLower}` });
    }

    return res.status(400).json({ success: false, message: 'Unknown action: ' + action });

  } catch (err) {
    console.error('Auth API error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: String(err)
    });
  }
};
