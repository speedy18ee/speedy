const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');

class AuthManager {
  constructor() {
    this.usersFile = path.join(config.dataDir, 'users.json');
    this.adminFile = path.join(config.dataDir, 'admin.json');
    this.sessions = new Map(); // token -> { user, expiresAt }
    this.adminSessions = new Set(); // admin tokens
    this.init();
  }

  init() {
    if (!fs.existsSync(config.dataDir)) {
      fs.mkdirSync(config.dataDir, { recursive: true });
    }

    this.users = this.loadJSON(this.usersFile, []).map(u => ({
      ...u,
      botLimit: typeof u.botLimit === 'number' ? u.botLimit : 10
    }));
    this.adminConfig = this.loadJSON(this.adminFile, {
      adminKey: 'admin123', // Default admin panel password
      dashboardName: 'EXC'
    });

    // Ensure at least one default user exists for immediate access if empty
    if (this.users.length === 0) {
      this.createUser('exc_user', 'exc123', { note: 'Default Initial User' });
      logger.info('AUTH', 'Created default initial user: exc_user / exc123');
    }
  }

  loadJSON(filePath, fallback) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch (e) {
      logger.error('AUTH', `Failed to load ${filePath}: ${e.message}`);
    }
    return fallback;
  }

  saveUsers() {
    try {
      const tmp = `${this.usersFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.users, null, 2), 'utf-8');
      fs.renameSync(tmp, this.usersFile);
    } catch (e) {
      logger.error('AUTH', `Failed to save users: ${e.message}`);
    }
  }

  saveAdmin() {
    try {
      const tmp = `${this.adminFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.adminConfig, null, 2), 'utf-8');
      fs.renameSync(tmp, this.adminFile);
    } catch (e) {
      logger.error('AUTH', `Failed to save admin config: ${e.message}`);
    }
  }

  // --- User Authentication with 1-Device HWID Lock ---
  login(username, password, clientHwid, deviceInfo = {}) {
    if (!username || !password) {
      throw new Error('Username and password are required');
    }

    if (!clientHwid) {
      throw new Error('Device Hardware ID (HWID) is required to authenticate');
    }

    const cleanUser = username.trim().toLowerCase();
    const user = this.users.find(u => u.username.toLowerCase() === cleanUser);

    if (!user || user.password !== password) {
      throw new Error('Invalid username or password');
    }

    if (user.status === 'suspended') {
      throw new Error('Account suspended. Contact administrator.');
    }

    // 1-Device HWID Verification
    if (!user.hwid) {
      // First device login: Lock account permanently to this HWID!
      user.hwid = clientHwid;
      user.boundDevice = {
        platform: deviceInfo.platform || 'Unknown',
        browser: deviceInfo.browser || 'Unknown',
        screen: deviceInfo.screen || 'Unknown',
        boundAt: new Date().toISOString()
      };
      user.lastLogin = new Date().toISOString();
      this.saveUsers();
      logger.success('AUTH', `[HWID LOCK] Bound account "${user.username}" to device HWID: ${clientHwid.substring(0, 16)}...`);
    } else {
      // Subsequent login: must strictly match the locked HWID
      if (user.hwid !== clientHwid) {
        logger.warn('AUTH', `[HWID REJECT] User "${user.username}" attempted login from unauthorized device! Mismatch detected.`);
        throw new Error('Access Denied: This account is locked to 1 device only (HWID Lock). Contact administrator to reset HWID.');
      }
      user.lastLogin = new Date().toISOString();
      this.saveUsers();
    }

    // Generate Session Token
    const token = 'exc_usr_' + crypto.randomBytes(24).toString('hex');
    const userBotLimit = user.botLimit || 10;
    this.sessions.set(token, {
      userId: user.id,
      username: user.username,
      hwid: user.hwid,
      botLimit: userBotLimit,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    return {
      token,
      user: {
        id: user.id,
        username: user.username,
        hwid: user.hwid,
        botLimit: userBotLimit,
        status: user.status
      }
    };
  }

  verifySession(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    const liveUser = this.users.find(u => u.id === session.userId);
    if (liveUser) {
      session.botLimit = liveUser.botLimit || 10;
      session.status = liveUser.status;
    }
    return session;
  }

  logout(token) {
    this.sessions.delete(token);
  }

  // --- Admin Credential Management ---
  verifyAdminKey(adminKey) {
    return this.adminConfig.adminKey === adminKey;
  }

  adminLogin(adminKey) {
    if (!this.verifyAdminKey(adminKey)) {
      throw new Error('Invalid Admin Key / Password');
    }
    const token = 'exc_adm_' + crypto.randomBytes(24).toString('hex');
    this.adminSessions.add(token);
    return { token };
  }

  verifyAdminSession(token) {
    if (!token) return false;
    return this.adminSessions.has(token);
  }

  adminLogout(token) {
    this.adminSessions.delete(token);
  }

  createUser(username, password, meta = {}) {
    const cleanUser = username.trim().toLowerCase();
    if (!cleanUser || !password) {
      throw new Error('Username and password are required');
    }
    if (this.users.some(u => u.username.toLowerCase() === cleanUser)) {
      throw new Error(`Username "${username}" already exists`);
    }

    const botLimit = meta.botLimit !== undefined ? (parseInt(meta.botLimit, 10) || 10) : 10;

    const newUser = {
      id: 'usr_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      username: username.trim(),
      password: password.trim(),
      hwid: null, // Unbound until first device login
      botLimit: Math.max(1, botLimit),
      status: 'active',
      note: meta.note || '',
      boundDevice: null,
      createdAt: new Date().toISOString(),
      lastLogin: null
    };

    this.users.push(newUser);
    this.saveUsers();
    logger.info('AUTH', `Admin created new user credential: ${newUser.username} (Bot Limit: ${newUser.botLimit})`);
    return newUser;
  }

  updateUserLimit(userId, newLimit) {
    const user = this.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found');
    const limit = Math.max(1, parseInt(newLimit, 10) || 10);
    user.botLimit = limit;
    this.saveUsers();
    for (const [token, sess] of this.sessions.entries()) {
      if (sess.userId === userId) {
        sess.botLimit = limit;
      }
    }
    logger.info('AUTH', `Admin updated bot limit for "${user.username}" to ${limit}`);
    return user;
  }

  resetUserHwid(userId) {
    const user = this.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found');
    const oldHwid = user.hwid;
    user.hwid = null;
    user.boundDevice = null;
    this.saveUsers();
    // Invalidate any active session for this user
    for (const [token, sess] of this.sessions.entries()) {
      if (sess.userId === userId) this.sessions.delete(token);
    }
    logger.success('AUTH', `[HWID RESET] Cleared HWID for user "${user.username}" (previously ${oldHwid ? oldHwid.substring(0, 16) : 'none'})`);
    return user;
  }

  toggleUserStatus(userId) {
    const user = this.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found');
    user.status = user.status === 'active' ? 'suspended' : 'active';
    this.saveUsers();
    if (user.status === 'suspended') {
      for (const [token, sess] of this.sessions.entries()) {
        if (sess.userId === userId) this.sessions.delete(token);
      }
    }
    return user;
  }

  deleteUser(userId) {
    const idx = this.users.findIndex(u => u.id === userId);
    if (idx === -1) throw new Error('User not found');
    const removed = this.users.splice(idx, 1)[0];
    this.saveUsers();
    for (const [token, sess] of this.sessions.entries()) {
      if (sess.userId === userId) this.sessions.delete(token);
    }
    logger.info('AUTH', `Deleted user credential: ${removed.username}`);
    return true;
  }

  getUsersList() {
    return this.users.map(u => ({
      id: u.id,
      username: u.username,
      password: u.password,
      hwid: u.hwid,
      botLimit: u.botLimit || 10,
      isBound: !!u.hwid,
      boundDevice: u.boundDevice,
      status: u.status,
      note: u.note,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin
    }));
  }
}

module.exports = new AuthManager();
