// api/auth.js - Unified Auth API (Registration, Login, Time, Admin)

const crypto = require('crypto');

const ADMIN_USERS = ['vanmanh', 'depchai'];
const DEFAULT_TIME = 120; // 2 hours for new users

async function upstash(command, ...args) {
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error('Upstash credentials missing');
    return null;
  }
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

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.connection?.remoteAddress || 'unknown';
}

async function logAction(type, data) {
  try {
    const entry = { type, ...data, at: new Date().toISOString() };
    await upstash('LPUSH', 'userlogs', JSON.stringify(entry));
    await upstash('LTRIM', 'userlogs', '0', '499');
  } catch (e) {
    console.error('Log error:', e);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

  try {
    const body = req.body || {};
    const { action } = body;
    const clientIP = getClientIP(req);

    // ============ REGISTER ============
    if (action === 'register') {
      const { username, password } = body;
      
      if (!username || !password) {
        return res.json({ success: false, message: 'Thiếu username hoặc password' });
      }
      
      if (username.length < 3 || username.length > 20) {
        return res.json({ success: false, message: 'Username phải từ 3-20 ký tự' });
      }
      
      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.json({ success: false, message: 'Username chỉ được chứa chữ, số và gạch dưới' });
      }
      
      if (password.length < 6) {
        return res.json({ success: false, message: 'Password phải ít nhất 6 ký tự' });
      }

      // Check existing user
      const existingUser = await upstash('GET', `user:${username.toLowerCase()}`);
      if (existingUser) {
        return res.json({ success: false, message: 'Username đã tồn tại' });
      }

      // Check IP registration limit (max 3 accounts per IP)
      const ipKey = `ip_reg:${clientIP}`;
      const ipCount = parseInt(await upstash('GET', ipKey) || '0');
      if (ipCount >= 3) {
        return res.json({ success: false, message: 'IP này đã đăng ký quá nhiều tài khoản' });
      }

      // Create user
      const salt = crypto.randomBytes(16).toString('hex');
      const hashedPassword = hashPassword(password, salt);
      
      const userData = {
        username: username.toLowerCase(),
        displayName: username,
        passwordHash: hashedPassword,
        salt,
        createdAt: new Date().toISOString(),
        registerIP: clientIP,
        lastLoginAt: null,
        lastLoginIP: null,
        isBanned: false,
        banReason: null,
        banExpires: null,
        isAdmin: ADMIN_USERS.includes(username.toLowerCase())
      };

      await upstash('SET', `user:${username.toLowerCase()}`, JSON.stringify(userData));
      
      // Set initial time in separate key
      const timeKey = `time:${username.toLowerCase()}`;
      await upstash('SET', timeKey, String(DEFAULT_TIME));
      
      // Track IP registrations (expire after 24h)
      await upstash('INCR', ipKey);
      await upstash('EXPIRE', ipKey, '86400');

      await logAction('register', { username: username.toLowerCase(), ip: clientIP });

      return res.json({ 
        success: true, 
        message: 'Đăng ký thành công!',
        user: {
          username: username.toLowerCase(),
          displayName: username,
          timeMinutes: DEFAULT_TIME,
          isAdmin: userData.isAdmin
        }
      });
    }

    // ============ LOGIN ============
    if (action === 'login') {
      const { username, password } = body;
      
      if (!username || !password) {
        return res.json({ success: false, message: 'Thiếu username hoặc password' });
      }

      const userKey = `user:${username.toLowerCase()}`;
      const raw = await upstash('GET', userKey);
      
      if (!raw) {
        return res.json({ success: false, message: 'Sai username hoặc password' });
      }

      const userData = JSON.parse(raw);

      // Check ban status
      if (userData.isBanned) {
        if (userData.banExpires) {
          const expiresAt = new Date(userData.banExpires);
          if (expiresAt > new Date()) {
            return res.json({ 
              success: false, 
              message: `Tài khoản bị khóa đến ${expiresAt.toLocaleString('vi-VN')}. Lý do: ${userData.banReason || 'Vi phạm quy định'}` 
            });
          } else {
            // Ban expired, unban
            userData.isBanned = false;
            userData.banReason = null;
            userData.banExpires = null;
            await upstash('SET', userKey, JSON.stringify(userData));
          }
        } else {
          return res.json({ 
            success: false, 
            message: `Tài khoản bị khóa vĩnh viễn. Lý do: ${userData.banReason || 'Vi phạm quy định'}` 
          });
        }
      }

      // Verify password
      const hashedInput = hashPassword(password, userData.salt);
      if (hashedInput !== userData.passwordHash) {
        return res.json({ success: false, message: 'Sai username hoặc password' });
      }

      // Update login info
      userData.lastLoginAt = new Date().toISOString();
      userData.lastLoginIP = clientIP;
      await upstash('SET', userKey, JSON.stringify(userData));

      // Get time from separate key
      const timeKey = `time:${username.toLowerCase()}`;
      const timeRaw = await upstash('GET', timeKey);
      const timeMinutes = timeRaw ? parseInt(timeRaw) || 0 : 0;

      await logAction('login', { username: username.toLowerCase(), ip: clientIP });

      return res.json({ 
        success: true, 
        message: 'Đăng nhập thành công!',
        user: {
          username: userData.username,
          displayName: userData.displayName,
          timeMinutes: timeMinutes,
          isAdmin: userData.isAdmin || ADMIN_USERS.includes(userData.username)
        }
      });
    }

    // ============ GET TIME ============
    if (action === 'getTime') {
      const { username } = body;
      if (!username) {
        return res.json({ success: false, message: 'Thiếu username' });
      }

      const timeKey = `time:${username.toLowerCase()}`;
      const raw = await upstash('GET', timeKey);
      const minutes = raw ? parseInt(raw) || 0 : 0;

      return res.json({ success: true, minutes });
    }

    // ============ UPDATE TIME (Admin) ============
    if (action === 'updateTime') {
      const { username, minutes, operation } = body;
      
      if (!username || minutes === undefined) {
        return res.json({ success: false, message: 'Thiếu thông tin' });
      }

      const timeKey = `time:${username.toLowerCase()}`;
      const raw = await upstash('GET', timeKey);
      let currentMinutes = raw ? parseInt(raw) || 0 : 0;
      let newMinutes = currentMinutes;

      if (operation === 'add') {
        newMinutes = currentMinutes + parseInt(minutes);
      } else if (operation === 'deduct') {
        newMinutes = Math.max(0, currentMinutes - parseInt(minutes));
      } else if (operation === 'set') {
        newMinutes = parseInt(minutes);
      } else {
        newMinutes = currentMinutes + parseInt(minutes);
      }

      await upstash('SET', timeKey, String(newMinutes));

      await logAction('updateTime', { 
        target: username.toLowerCase(), 
        ip: clientIP, 
        operation: operation || 'add',
        amount: minutes,
        previousMinutes: currentMinutes,
        newMinutes 
      });

      return res.json({ success: true, newMinutes });
    }

    // ============ GET ALL USERS (Admin) ============
    if (action === 'getAllUsers') {
      // Get all user keys
      const keys = await upstash('KEYS', 'user:*');
      
      if (!keys || keys.length === 0) {
        return res.json({ success: true, users: [] });
      }

      const users = [];
      for (const key of keys) {
        const raw = await upstash('GET', key);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            
            // IMPORTANT: Get time from separate time:{username} key
            const timeKey = `time:${parsed.username}`;
            const timeRaw = await upstash('GET', timeKey);
            const timeMinutes = timeRaw ? parseInt(timeRaw) || 0 : 0;
            
            users.push({
              username: parsed.username,
              displayName: parsed.displayName,
              timeMinutes: timeMinutes, // Use time from time: key, not user: key
              registerIP: parsed.registerIP,
              lastLoginIP: parsed.lastLoginIP,
              createdAt: parsed.createdAt,
              lastLoginAt: parsed.lastLoginAt,
              isBanned: parsed.isBanned,
              banReason: parsed.banReason,
              banExpires: parsed.banExpires,
              banType: parsed.banExpires ? 'temporary' : (parsed.isBanned ? 'permanent' : null),
              isAdmin: parsed.isAdmin || ADMIN_USERS.includes(parsed.username)
            });
          } catch (e) {
            console.error('Parse user error:', e);
          }
        }
      }

      return res.json({ success: true, users });
    }

    // ============ BAN USER (Admin) ============
    if (action === 'banUser') {
      const { targetUsername, banDuration, banUnit, banReason } = body;
      
      if (!targetUsername) {
        return res.json({ success: false, message: 'Thiếu username' });
      }

      const userKey = `user:${targetUsername.toLowerCase()}`;
      const raw = await upstash('GET', userKey);
      
      if (!raw) {
        return res.json({ success: false, message: 'User không tồn tại' });
      }

      const userData = JSON.parse(raw);
      userData.isBanned = true;
      userData.banReason = banReason || 'Vi phạm quy định';

      // Calculate ban expiration
      if (banDuration && banDuration > 0) {
        const now = new Date();
        let expiresAt = now;
        
        switch (banUnit) {
          case 'hours':
            expiresAt = new Date(now.getTime() + banDuration * 60 * 60 * 1000);
            break;
          case 'days':
            expiresAt = new Date(now.getTime() + banDuration * 24 * 60 * 60 * 1000);
            break;
          default:
            expiresAt = new Date(now.getTime() + banDuration * 60 * 60 * 1000);
        }
        
        userData.banExpires = expiresAt.toISOString();
      } else {
        // Permanent ban
        userData.banExpires = null;
      }

      await upstash('SET', userKey, JSON.stringify(userData));

      await logAction('banUser', { 
        target: targetUsername.toLowerCase(), 
        ip: clientIP,
        duration: banDuration,
        unit: banUnit,
        reason: userData.banReason,
        isPermanent: !userData.banExpires
      });

      return res.json({ success: true, message: `Đã ban ${targetUsername}` });
    }

    // ============ UNBAN USER (Admin) ============
    if (action === 'unbanUser') {
      const { targetUsername } = body;
      
      if (!targetUsername) {
        return res.json({ success: false, message: 'Thiếu username' });
      }

      const userKey = `user:${targetUsername.toLowerCase()}`;
      const raw = await upstash('GET', userKey);
      
      if (!raw) {
        return res.json({ success: false, message: 'User không tồn tại' });
      }

      const userData = JSON.parse(raw);
      userData.isBanned = false;
      userData.banReason = null;
      userData.banExpires = null;

      await upstash('SET', userKey, JSON.stringify(userData));

      await logAction('unbanUser', { target: targetUsername.toLowerCase(), ip: clientIP });

      return res.json({ success: true, message: `Đã unban ${targetUsername}` });
    }

    // ============ CHECK BAN STATUS ============
    if (action === 'checkBan') {
      const { username } = body;
      
      if (!username) {
        return res.json({ success: false, message: 'Thiếu username' });
      }

      const userKey = `user:${username.toLowerCase()}`;
      const raw = await upstash('GET', userKey);
      
      if (!raw) {
        return res.json({ success: true, isBanned: false });
      }

      const userData = JSON.parse(raw);

      if (userData.isBanned) {
        if (userData.banExpires) {
          const expiresAt = new Date(userData.banExpires);
          if (expiresAt > new Date()) {
            return res.json({ 
              success: true, 
              isBanned: true, 
              banReason: userData.banReason,
              banExpires: userData.banExpires
            });
          } else {
            // Auto-unban expired bans
            userData.isBanned = false;
            userData.banReason = null;
            userData.banExpires = null;
            await upstash('SET', userKey, JSON.stringify(userData));
            return res.json({ success: true, isBanned: false });
          }
        } else {
          return res.json({ 
            success: true, 
            isBanned: true, 
            banReason: userData.banReason,
            isPermanent: true
          });
        }
      }

      return res.json({ success: true, isBanned: false });
    }

    return res.json({ success: false, message: 'Unknown action' });

  } catch (err) {
    console.error('Auth API error:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
};
