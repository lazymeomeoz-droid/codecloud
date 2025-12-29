// API for user authentication - Vercel Serverless Function
// Using in-memory + JSON file storage (NO DATABASE)

const fs = require('fs');
const path = require('path');

const FREE_TIME_FOR_NEW_USER = 30;

// Admin accounts (hardcoded)
const ADMIN_ACCOUNTS = [
  { username: 'vanmanh', password: 'vanmanh' },
  { username: 'depchai', password: 'depchai' }
];

// File paths for data storage
const DATA_DIR = '/tmp';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TIMES_FILE = path.join(DATA_DIR, 'user_times.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const IP_REGISTRY_FILE = path.join(DATA_DIR, 'ip_registry.json');

// =====================================================
// FILE HELPERS
// =====================================================

function readJsonFile(filePath, defaultValue = {}) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error(`Error reading ${filePath}:`, e.message);
  }
  return defaultValue;
}

function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error(`Error writing ${filePath}:`, e.message);
    return false;
  }
}

// =====================================================
// DATA ACCESS FUNCTIONS
// =====================================================

function getUsers() {
  return readJsonFile(USERS_FILE, {});
}

function saveUsers(users) {
  return writeJsonFile(USERS_FILE, users);
}

function getTimes() {
  return readJsonFile(TIMES_FILE, {});
}

function saveTimes(times) {
  return writeJsonFile(TIMES_FILE, times);
}

function getConfig() {
  return readJsonFile(CONFIG_FILE, { githubToken: '' });
}

function saveConfig(config) {
  return writeJsonFile(CONFIG_FILE, config);
}

function getIpRegistry() {
  return readJsonFile(IP_REGISTRY_FILE, {});
}

function saveIpRegistry(registry) {
  return writeJsonFile(IP_REGISTRY_FILE, registry);
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
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.connection?.remoteAddress || 'unknown';
}

function checkBanStatus(user) {
  if (!user || !user.isBanned) return false;
  
  if (user.banType === 'permanent') return true;
  
  if (user.banUntil) {
    const banUntilDate = new Date(user.banUntil);
    if (banUntilDate <= new Date()) {
      // Ban expired - auto unban
      return false;
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
      const users = getUsers();
      const user = users[usernameLower];

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
        users[usernameLower] = user;
        saveUsers(users);
      }

      // Update last login
      user.lastLoginIP = clientIP;
      user.lastLoginAt = new Date().toISOString();
      users[usernameLower] = user;
      saveUsers(users);

      // Get user time
      const times = getTimes();
      const timeMinutes = times[usernameLower] || 0;

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

      const users = getUsers();
      
      // Check if username exists
      if (users[usernameLower]) {
        return res.status(400).json({ success: false, message: 'Tên đăng nhập đã tồn tại' });
      }

      // Check IP for multi-account
      const ipRegistry = getIpRegistry();
      let isBanned = false;
      let existingUser = null;
      
      if (ipRegistry[clientIP]) {
        // IP already has an account
        existingUser = ipRegistry[clientIP].firstUsername;
        isBanned = true;
        
        // Update registry
        ipRegistry[clientIP].allUsernames = ipRegistry[clientIP].allUsernames || [];
        if (!ipRegistry[clientIP].allUsernames.includes(usernameLower)) {
          ipRegistry[clientIP].allUsernames.push(usernameLower);
        }
        ipRegistry[clientIP].accountCount = (ipRegistry[clientIP].accountCount || 1) + 1;
        ipRegistry[clientIP].lastActivity = new Date().toISOString();
      } else {
        // New IP
        ipRegistry[clientIP] = {
          firstUsername: usernameLower,
          allUsernames: [usernameLower],
          accountCount: 1,
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString()
        };
      }
      saveIpRegistry(ipRegistry);

      // Create user
      const newUser = {
        username: usernameLower,
        passwordHash: hashPassword(password),
        registerIP: clientIP,
        createdAt: new Date().toISOString(),
        isBanned: isBanned,
        banType: isBanned ? 'permanent' : null,
        banReason: isBanned ? `Tài khoản phụ (IP trùng với ${existingUser})` : null
      };
      
      users[usernameLower] = newUser;
      saveUsers(users);

      // Set initial time
      const times = getTimes();
      times[usernameLower] = isBanned ? 0 : FREE_TIME_FOR_NEW_USER;
      saveTimes(times);

      if (isBanned) {
        return res.status(403).json({ 
          success: false, 
          message: `Phát hiện tài khoản phụ! IP của bạn đã đăng ký tài khoản "${existingUser}". Tài khoản mới đã bị khóa.`
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
      const times = getTimes();
      return res.json({ success: true, minutes: times[usernameLower] || 0 });
    }

    // === UPDATE TIME ===
    if (action === 'updateTime') {
      if (!usernameLower) {
        return res.status(400).json({ success: false, message: 'Missing username' });
      }
      if (typeof minutes !== 'number') {
        return res.status(400).json({ success: false, message: 'Invalid minutes' });
      }

      const times = getTimes();
      const previousMinutes = times[usernameLower] || 0;
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

      times[usernameLower] = newMinutes;
      saveTimes(times);

      return res.json({
        success: true,
        previousMinutes,
        newMinutes
      });
    }

    // === GET ALL USERS (Admin) ===
    if (action === 'getAllUsers') {
      const users = getUsers();
      const times = getTimes();
      
      const userList = Object.values(users).map(u => ({
        username: u.username,
        createdAt: u.createdAt,
        timeMinutes: times[u.username] || 0,
        isBanned: u.isBanned || false,
        banType: u.banType,
        banUntil: u.banUntil,
        banReason: u.banReason,
        registerIP: u.registerIP,
        lastLoginIP: u.lastLoginIP,
        lastLoginAt: u.lastLoginAt
      }));

      return res.json({
        success: true,
        users: userList,
        times
      });
    }

    // === BAN USER (Admin) ===
    if (action === 'banUser') {
      if (!usernameLower) {
        return res.status(400).json({ success: false, message: 'Missing username' });
      }
      
      const users = getUsers();
      const user = users[usernameLower];
      
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
      
      users[usernameLower] = user;
      saveUsers(users);
      
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
      
      const users = getUsers();
      const user = users[usernameLower];
      
      if (!user) {
        return res.status(404).json({ success: false, message: 'User không tồn tại' });
      }
      
      user.isBanned = false;
      user.banType = null;
      user.banUntil = null;
      user.banReason = null;
      
      users[usernameLower] = user;
      saveUsers(users);
      
      return res.json({ success: true, message: `Đã unban user ${usernameLower}` });
    }

    // === GET CONFIG (Admin) ===
    if (action === 'getConfig') {
      const config = getConfig();
      return res.json({
        success: true,
        hasGithubToken: !!config.githubToken,
        githubToken: config.githubToken || ''
      });
    }

    // === SET CONFIG (Admin) ===
    if (action === 'setConfig') {
      const { githubToken: newToken } = body;
      
      if (newToken) {
        // Verify token with GitHub
        try {
          const verifyRes = await fetch('https://api.github.com/user', {
            headers: {
              'Authorization': `Bearer ${newToken}`,
              'Accept': 'application/vnd.github+json'
            }
          });
          
          if (!verifyRes.ok) {
            return res.status(400).json({ success: false, message: 'Token không hợp lệ' });
          }
          
          const config = getConfig();
          config.githubToken = newToken;
          saveConfig(config);
          
        } catch (e) {
          return res.status(400).json({ success: false, message: 'Không thể xác minh token: ' + e.message });
        }
      }
      
      return res.json({ success: true, message: 'Cấu hình đã được lưu' });
    }

    // === GET ADMIN TOKEN (for VPS creation) ===
    if (action === 'getAdminToken') {
      const config = getConfig();
      return res.json({
        success: true,
        token: config.githubToken || ''
      });
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
