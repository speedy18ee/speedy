require('./src/patch');
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const config = require('./src/config');
const database = require('./src/database');
const mongoDb = require('./src/mongoDb');
// Connect to MongoDB Atlas
mongoDb.connect().catch(() => {});
const logger = require('./src/logger');
const authManager = require('./src/authManager');
const LavalinkClient = require('./src/lavalinkClient');
const BotManager = require('./src/botManager');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const fs = require('fs');
fs.mkdirSync(path.join(__dirname, 'public', 'uploads'), { recursive: true });

app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Main Pages: Login, Dashboard & Credentials
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.get('/credentials', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/credentials.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- AUTH MIDDLEWARE ---
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : (req.query.token || req.headers['x-access-token']);
  const session = authManager.verifySession(token);
  if (!session) {
    return res.status(401).json({ success: false, error: 'Unauthorized. Please login to EXC.' });
  }
  req.user = session;
  next();
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : (req.query.adminToken || req.headers['x-admin-token']);
  if (!authManager.verifyAdminSession(token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized admin access' });
  }
  next();
}

// --- PUBLIC AUTH ENDPOINTS ---
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password, hwid, deviceInfo } = req.body;
    const result = authManager.login(username, password, hwid, deviceInfo);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  if (token) authManager.logout(token);
  res.json({ success: true });
});

// --- RENDER 24/7 KEEP-ALIVE & STATUS PING ---
app.get(['/api/ping', '/healthz'], (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

// Self-ping every 4 minutes to guarantee Render container stays awake 24/7
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://exc-selfbot.onrender.com';
setInterval(() => {
  if (RENDER_EXTERNAL_URL && RENDER_EXTERNAL_URL.startsWith('http')) {
    fetch(`${RENDER_EXTERNAL_URL}/api/ping`)
      .then(r => r.json())
      .catch(() => {});
  }
}, 4 * 60 * 1000);

// --- ADMIN MANAGEMENT ENDPOINTS ---
app.post('/api/admin/login', (req, res) => {
  try {
    const { adminKey } = req.body;
    const result = authManager.adminLogin(adminKey);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  if (token) authManager.adminLogout(token);
  res.json({ success: true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ success: true, users: authManager.getUsersList() });
});

app.get('/api/admin/backup', requireAdmin, (req, res) => {
  res.json({
    success: true,
    users: authManager.getUsersList(),
    accounts: database.accounts,
    settings: database.settings
  });
});

app.post('/api/admin/restore', requireAdmin, (req, res) => {
  try {
    const { users, accounts } = req.body;
    let restoredUsers = 0;
    let restoredAccounts = 0;
    if (Array.isArray(users)) {
      restoredUsers = authManager.restoreUsers(users);
    }
    if (Array.isArray(accounts)) {
      restoredAccounts = database.restoreAccounts(accounts);
    }
    logger.success('ADMIN', `Manual/Auto restore executed: ${restoredUsers} user(s), ${restoredAccounts} bot(s).`);
    res.json({ success: true, restoredUsers, restoredAccounts });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

const cloudSync = require('./src/cloudSync');

app.get('/api/admin/cloud-status', requireAdmin, (req, res) => {
  res.json({
    success: true,
    available: cloudSync.isAvailable(),
    lastSync: cloudSync.lastSync,
    usersCount: authManager.users.length,
    accountsCount: database.accounts.length
  });
});

app.post('/api/admin/sync-cloud', requireAdmin, async (req, res) => {
  try {
    const result = await cloudSync.syncNow();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const { username, password, note, botLimit } = req.body;
    const user = authManager.createUser(username, password, { note, botLimit });
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/users/:id/limit', requireAdmin, (req, res) => {
  try {
    const { limit } = req.body;
    const user = authManager.updateUserLimit(req.params.id, limit);
    broadcast('userLimitUpdated', { userId: user.id, username: user.username, botLimit: user.botLimit });
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/users/:id/reset-hwid', requireAdmin, (req, res) => {
  try {
    const user = authManager.resetUserHwid(req.params.id);
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/users/:id/toggle', requireAdmin, (req, res) => {
  try {
    const user = authManager.toggleUserStatus(req.params.id);
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  try {
    authManager.deleteUser(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Initialize Lavalink & Bot Manager
const currentSettings = database.getSettings();
const lavalink = new LavalinkClient(currentSettings.lavalink || config.defaultNode);
const botManager = new BotManager(lavalink);
global.botManager = botManager;

// Start Lavalink connection
lavalink.connect();

// Broadcast to connected WebSocket clients (respects user isolation)
function broadcast(type, data, targetOwnerId = null) {
  const payload = JSON.stringify({ type, data });
  const ownerId = targetOwnerId || data?.ownerId || data?.player?.ownerId || null;

  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      // If message is targeted to a specific owner, only send to matching authenticated client
      if (ownerId && (!client.userId || client.userId !== ownerId)) {
        return;
      }
      client.send(payload);
    }
  });
}

// Wire up events to WebSocket broadcast with owner isolation
logger.on('log', entry => broadcast('log', entry));
logger.on('cleared', () => broadcast('logsCleared', {}));

lavalink.on('stats', stats => broadcast('lavalinkStats', stats));
lavalink.on('ready', session => broadcast('lavalinkReady', session));
lavalink.on('disconnect', () => broadcast('lavalinkDisconnect', {}));
lavalink.on('playerUpdate', player => broadcast('playerUpdate', player, player.ownerId));
lavalink.on('trackStart', data => broadcast('trackStart', data, data.ownerId || data.player?.ownerId));
lavalink.on('queueUpdate', player => broadcast('queueUpdate', player, player.ownerId));
lavalink.on('queueEnd', player => broadcast('queueEnd', player, player.ownerId));

botManager.on('botStatus', data => {
  const acc = database.getAccount(data.accountId);
  broadcast('botStatus', { ...data, ownerId: acc?.ownerId });
});
botManager.on('botVoice', data => {
  const acc = database.getAccount(data.accountId);
  broadcast('botVoice', { ...data, ownerId: acc?.ownerId });
});

// --- REST API ENDPOINTS ---
app.use('/api/accounts', requireAuth);
app.use('/api/music', requireAuth);
app.use('/api/actions', requireAuth);
app.use('/api/guilds', requireAuth);

// 1. Accounts API (Strictly Partitioned by User Credentials)
// MongoDB Atlas Status Endpoint
app.get('/api/database/status', (req, res) => {
  res.json({ success: true, ...mongoDb.getStatus() });
});

app.get('/api/accounts', async (req, res) => {
  try {
    const current = database.getAccounts(req.user.userId);
    if (current.length === 0 && mongoDb.isConnected) {
      const restored = await mongoDb.syncFromCloud(req.user.userId);
      if (restored > 0) {
        botManager.startAll(req.user.userId).catch(() => {});
      }
    }
  } catch (_) {}
  res.json({ success: true, accounts: botManager.getAllBotsStatus(req.user.userId) });
});

app.post('/api/accounts', async (req, res) => {
  try {
    const { token, label, autoStart, proxy } = req.body;
    if (!token || !token.trim()) {
      return res.status(400).json({ success: false, error: 'Token is required' });
    }

    // Enforce bot limit per credentials (e.g. 10 bots limit) for this specific user
    const maxLimit = (req.user && typeof req.user.botLimit === 'number') ? req.user.botLimit : 10;
    const userAccounts = database.getAccounts(req.user.userId);
    if (userAccounts.length >= maxLimit) {
      return res.status(400).json({
        success: false,
        error: `Bot limit reached! Your login credentials allow a maximum of ${maxLimit} bots (Currently using: ${userAccounts.length}/${maxLimit}).`
      });
    }

    const newAcc = database.addAccount({
      token,
      label,
      proxy: proxy ? proxy.trim() : null,
      autoStart,
      ownerId: req.user.userId,
      ownerUsername: req.user.username
    });
    logger.success('DASHBOARD', `User [${req.user.username}] added account: ${newAcc.label} (${userAccounts.length + 1}/${maxLimit})`);

    // Auto-start if requested
    if (newAcc.autoStart !== false) {
      botManager.startAccount(newAcc.id).catch(e => {
        logger.error('BOT', `Initial start failed: ${e.message}`);
      });
    }

    res.json({ success: true, account: newAcc });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Mass Token Import / Token Manager (Paste all tokens at once)
app.post('/api/accounts/mass', async (req, res) => {
  try {
    const { tokens, autoStart = true } = req.body;
    if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ success: false, error: 'Tokens array is required' });
    }

    const maxLimit = (req.user && typeof req.user.botLimit === 'number') ? req.user.botLimit : 10;
    const currentAccounts = database.getAccounts(req.user.userId);
    const availableSlots = Math.max(0, maxLimit - currentAccounts.length);

    if (availableSlots <= 0) {
      return res.status(400).json({
        success: false,
        error: `Bot limit reached! Your credentials allow a maximum of ${maxLimit} bots (Currently using: ${currentAccounts.length}/${maxLimit}).`
      });
    }

    const added = [];
    const skipped = [];
    const errors = [];

    const existingTokens = new Set(currentAccounts.map(a => a.token.trim()));
    const existingUserIds = new Set();
    currentAccounts.forEach(a => {
      try {
        const payload = a.token.split('.')[0];
        const uid = Buffer.from(payload, 'base64').toString('utf8');
        if (/^\d{17,20}$/.test(uid)) existingUserIds.add(uid);
      } catch (e) {}
    });

    const seenInBatch = new Set();

    for (let i = 0; i < tokens.length; i++) {
      if (added.length >= availableSlots) {
        skipped.push({ token: tokens[i], reason: `Quota limit (${maxLimit}) reached` });
        continue;
      }

      const rawToken = typeof tokens[i] === 'string' ? tokens[i].trim() : (tokens[i]?.token || '').trim();
      if (!rawToken || rawToken.length < 25) continue;

      const tokenParts = rawToken.split('.');
      if (tokenParts.length < 3) {
        errors.push({ token: rawToken, reason: 'Invalid token format (must have 3 parts separated by dots)' });
        continue;
      }

      let tokenUid = null;
      try {
        const decoded = Buffer.from(tokenParts[0], 'base64').toString('utf8');
        if (/^\d{17,20}$/.test(decoded)) tokenUid = decoded;
      } catch (e) {}

      if (tokenUid && (existingUserIds.has(tokenUid) || seenInBatch.has(tokenUid))) {
        skipped.push({ token: rawToken, reason: `Account already added (Discord User ID: ${tokenUid})` });
        continue;
      }

      if (existingTokens.has(rawToken) || seenInBatch.has(rawToken)) {
        skipped.push({ token: rawToken, reason: 'Duplicate token' });
        continue;
      }

      if (tokenUid) seenInBatch.add(tokenUid);
      seenInBatch.add(rawToken);

      try {
        const defaultLabel = `Bot ${currentAccounts.length + added.length + 1}`;
        const label = (typeof tokens[i] === 'object' && tokens[i]?.label) ? tokens[i].label : defaultLabel;
        const newAcc = database.addAccount({
          token: rawToken,
          label,
          proxy: null,
          autoStart: autoStart !== false,
          ownerId: req.user.userId,
          ownerUsername: req.user.username
        });

        existingTokens.add(rawToken);
        if (tokenUid) existingUserIds.add(tokenUid);
        added.push(newAcc);

        if (newAcc.autoStart !== false) {
          const delay = added.length * 1500;
          setTimeout(() => {
            botManager.startAccount(newAcc.id).catch(e => {
              logger.error('BOT', `Mass initial start failed: ${e.message}`);
            });
          }, delay);
        }
      } catch (err) {
        errors.push({ token: rawToken, reason: err.message });
      }
    }

    logger.success('DASHBOARD', `User [${req.user.username}] mass-added ${added.length} accounts (${skipped.length} skipped, ${errors.length} errors)`);

    res.json({
      success: true,
      addedCount: added.length,
      skippedCount: skipped.length,
      errorCount: errors.length,
      added,
      skipped,
      errors
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all saved tokens for this user (for Token Manager Load)
app.get('/api/accounts/tokens', (req, res) => {
  try {
    const accounts = database.getAccounts(req.user.userId);
    const tokens = accounts.map(a => a.token).filter(Boolean);
    res.json({ success: true, count: tokens.length, tokens });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const acc = database.getAccount(id, req.user.userId);
    if (!acc) {
      return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    }
    await botManager.stopAccount(id);
    database.removeAccount(id, req.user.userId);
    logger.info('DASHBOARD', `User [${req.user.username}] removed account: ${id}`);
    broadcast('accountRemoved', { id, ownerId: req.user.userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/:id/start', async (req, res) => {
  try {
    const acc = database.getAccount(req.params.id, req.user.userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    await botManager.startAccount(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/:id/stop', async (req, res) => {
  try {
    const acc = database.getAccount(req.params.id, req.user.userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    await botManager.stopAccount(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/start-all', async (req, res) => {
  await botManager.startAll(req.user.userId);
  res.json({ success: true });
});

app.post('/api/accounts/stop-all', async (req, res) => {
  await botManager.stopAll(req.user.userId);
  res.json({ success: true });
});

// Mass Voice: Join ALL accounts to a Voice Channel & Enable 24/7
app.post('/api/accounts/voice/join-all', async (req, res) => {
  try {
    const { channelId, guildId, keep247, selfMute, selfDeaf } = req.body;
    if (!channelId || !channelId.trim()) {
      return res.status(400).json({ success: false, error: 'Voice Channel ID is required' });
    }
    const result = await botManager.joinAllToVoice(req.user.userId, channelId.trim(), {
      guildId,
      keep247: keep247 !== false,
      selfMute: !!selfMute,
      selfDeaf: !!selfDeaf
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mass Voice: Leave ALL accounts from Voice
app.post('/api/accounts/voice/leave-all', async (req, res) => {
  try {
    const { disable247 = true } = req.body;
    const result = await botManager.leaveAllVoice(req.user.userId, disable247);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Camera feature removed per request
app.post('/api/accounts/:id/camera', (req, res) => res.json({ success: true, message: 'WebCam feature disabled' }));
app.post('/api/accounts/camera/all', (req, res) => res.json({ success: true, message: 'WebCam feature disabled' }));

app.post('/api/accounts/:id/presence', (req, res) => {
  try {
    const acc = database.getAccount(req.params.id, req.user.userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    const { status, activity } = req.body;
    botManager.setStatus(req.params.id, status, activity);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/accounts/:id/guilds', async (req, res) => {
  try {
    const acc = database.getAccount(req.params.id, req.user.userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    const guilds = await botManager.getGuildsAndChannels(req.params.id);
    res.json({ success: true, guilds });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get deduplicated summary of all joined servers across online bots
app.get('/api/guilds/all', requireAuth, (req, res) => {
  try {
    const userId = req.user?.userId || null;
    const guilds = botManager.getAllGuildsSummary(userId);
    res.json({ success: true, guilds });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Permanent Server Leave for a Single Bot (with proxy rotation & 24/7 cleanup)
app.post('/api/accounts/:id/guilds/:guildId/leave', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || null;
    const acc = database.getAccount(req.params.id, userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    const useProxy = req.body.useProxy !== false;
    const result = await botManager.leaveGuild(req.params.id, req.params.guildId, { useProxy });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Permanent Server Leave for ALL BOTS (Mass Leave with proxy rotation & jitter stagger)
app.post('/api/guilds/:guildId/leave-all', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || null;
    const useProxy = req.body.useProxy !== false;
    const result = await botManager.leaveGuildAllBots(userId, req.params.guildId, { useProxy });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Voice & 24/7 API
app.post('/api/accounts/:id/voice/join', async (req, res) => {
  try {
    const acc = database.getAccount(req.params.id, req.user.userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    const { channelId, selfMute, selfDeaf } = req.body;
    if (!channelId) {
      return res.status(400).json({ success: false, error: 'Voice channel ID is required' });
    }
    const voiceState = await botManager.joinVoice(req.params.id, channelId, { selfMute, selfDeaf });
    res.json({ success: true, voiceState });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/:id/voice/leave', async (req, res) => {
  try {
    const acc = database.getAccount(req.params.id, req.user.userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    await botManager.leaveVoice(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/:id/voice/247', async (req, res) => {
  try {
    const acc = database.getAccount(req.params.id, req.user.userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    const { enabled, guildId, channelId, selfMute, selfDeaf } = req.body;
    const config = await botManager.set247(req.params.id, {
      enabled,
      guildId,
      channelId,
      selfMute,
      selfDeaf
    });
    res.json({ success: true, voice247: config });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 3. Lavalink & Music API
app.get('/api/lavalink/status', (req, res) => {
  res.json({
    success: true,
    node: {
      name: lavalink.name,
      host: lavalink.host,
      port: lavalink.port,
      secure: lavalink.secure,
      connected: lavalink.connected,
      sessionId: lavalink.sessionId,
      stats: lavalink.stats
    }
  });
});

app.post('/api/lavalink/config', async (req, res) => {
  try {
    const { url, name, auth, secure } = req.body;
    const newConfig = {
      url: url || lavalink.host + ':' + lavalink.port,
      name: name || lavalink.name,
      auth: auth || lavalink.auth,
      secure: !!secure
    };

    database.updateSettings({ lavalink: newConfig });
    lavalink.updateConfig(newConfig);
    if (lavalink.ws) lavalink.ws.close();
    lavalink.connect();

    logger.success('LAVALINK', `Node settings updated: ${newConfig.name} (${newConfig.url})`);
    res.json({ success: true, config: newConfig });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/music/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ success: false, error: 'Query parameter q required' });
    const result = await lavalink.loadTracks(q);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Custom Voice Recording & MP3 Audio Play/Queue Endpoint
app.post('/api/music/custom-audio', async (req, res) => {
  try {
    const { audioBase64, audioUrl: rawAudioUrl, filename, title, mode, accountId, guildId, channelId } = req.body;
    const ownerId = req.user.userId;
    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');

    // 1. Resolve target guild and voice channel automatically
    let targetGuildId = guildId;
    let targetChannelId = channelId;
    let targetBot = null;

    if (accountId && accountId !== 'ALL_BOTS') {
      targetBot = botManager.bots.get(accountId);
      if (targetBot?.currentVoice?.guildId) {
        targetGuildId = targetGuildId || targetBot.currentVoice.guildId;
        targetChannelId = targetChannelId || targetBot.currentVoice.channelId;
      }
    }

    // Auto-detect from currently connected voice bots
    if (!targetGuildId || !targetChannelId) {
      for (const ub of userBots) {
        const liveBot = botManager.bots.get(ub.id);
        if (liveBot?.currentVoice?.guildId && liveBot?.currentVoice?.channelId) {
          targetGuildId = targetGuildId || liveBot.currentVoice.guildId;
          targetChannelId = targetChannelId || liveBot.currentVoice.channelId;
          targetBot = targetBot || liveBot;
          break;
        }
      }
    }

    // Fallback: Auto-detect from 24/7 configuration in database
    if (!targetGuildId || !targetChannelId) {
      const accounts = database.getAccounts(ownerId);
      for (const acc of accounts) {
        if (acc.voice247 && acc.voice247.guildId && acc.voice247.channelId) {
          targetGuildId = targetGuildId || acc.voice247.guildId;
          targetChannelId = targetChannelId || acc.voice247.channelId;
          break;
        }
      }
    }

    if (!targetGuildId || !targetChannelId) {
      return res.status(400).json({
        success: false,
        error: 'No target voice channel found. Please connect your bots to a voice channel or enable 24/7 on a channel first.'
      });
    }

    let finalAudioUrl = rawAudioUrl;
    let savedSong = null;

    // 2. Handle uploaded MP3 or recorded audio
    if (!finalAudioUrl && audioBase64) {
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      const isMp3 = !filename || filename.toLowerCase().endsWith('.mp3');
      const ext = isMp3 ? '.mp3' : '.wav';
      const cleanName = (filename ? path.parse(filename).name : 'audio').replace(/[^a-zA-Z0-9_-]/g, '_');
      const storedFileName = `${Date.now()}_${cleanName}${ext}`;
      const localFilePath = path.join(__dirname, 'public', 'uploads', storedFileName);

      fs.writeFileSync(localFilePath, audioBuffer);
      logger.success('AUDIO', `Saved uploaded audio: ${storedFileName} (${(audioBuffer.length / (1024 * 1024)).toFixed(2)} MB)`);

      const host = req.get('host');
      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const localDirectUrl = `${protocol}://${host}/uploads/${storedFileName}`;

      // Upload to Catbox as CDN mirror
      let externalUrl = null;
      try {
        const mimeType = isMp3 ? 'audio/mpeg' : 'audio/wav';
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', new Blob([audioBuffer], { type: mimeType }), `${cleanName}${ext}`);
        const catRes = await fetch('https://catbox.moe/user/api.php', {
          method: 'POST',
          body: form,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        const urlText = await catRes.text();
        if (urlText && urlText.trim().startsWith('http')) {
          externalUrl = urlText.trim();
          logger.success('AUDIO', `Audio mirrored to Catbox: ${externalUrl}`);
        }
      } catch (catErr) {
        logger.warn('AUDIO', `Catbox mirror warning: ${catErr.message}`);
      }

      finalAudioUrl = externalUrl || localDirectUrl;

      // Save to persistent Uploaded Songs Library
      savedSong = database.saveUploadedSong({
        id: 'song_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
        ownerId,
        ownerUsername: req.user.username,
        title: title || cleanName.replace(/_/g, ' '),
        filename: filename || storedFileName,
        url: finalAudioUrl,
        mirrorUrl: externalUrl || null,
        localPath: `/uploads/${storedFileName}`,
        size: audioBuffer.length,
        sizeFormatted: `${(audioBuffer.length / (1024 * 1024)).toFixed(2)} MB`,
        isMp3,
        uploadedAt: new Date().toISOString()
      });
    }

    if (!finalAudioUrl) {
      return res.status(400).json({
        success: false,
        error: 'Could not process audio. Please provide a valid MP3 file or audio recording.'
      });
    }

    // 3. Load track via Lavalink
    let result = await lavalink.loadTracks(finalAudioUrl);
    if ((!result || !result.tracks || result.tracks.length === 0) && savedSong?.mirrorUrl) {
      result = await lavalink.loadTracks(savedSong.mirrorUrl);
      if (result && result.tracks && result.tracks.length > 0) {
        finalAudioUrl = savedSong.mirrorUrl;
      }
    }

    if (!result || !result.tracks || result.tracks.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Lavalink could not decode this audio stream. Please ensure the file is a valid MP3.'
      });
    }

    const track = result.tracks[0];
    const displayTitle = title || filename || (finalAudioUrl.includes('.mp3') ? 'Custom MP3 Audio' : 'Recorded Voice Note');
    track.info.title = displayTitle;
    track.info.author = finalAudioUrl.includes('.mp3') ? 'Uploaded MP3' : 'Voice Recording';

    const isSingle = req.body.singleBot === true;
    const isMass = !isSingle;

    if (isMass) {
      if (userBots.length === 0) {
        return res.status(400).json({ success: false, error: 'No online bots found under your account to play music.' });
      }

      logger.music('MASS_PLAY', `User [${req.user.username}] triggering ALL BOTS (${userBots.length}) audio playback: "${displayTitle}" at 1000% volume with 15dB 60Hz punch`);

      // Ensure all online bots join target voice channel
      let joinedAny = false;
      for (const ub of userBots) {
        const b = botManager.bots.get(ub.id);
        if (b && targetChannelId && b.currentVoice?.channelId !== targetChannelId) {
          try {
            await botManager.joinVoice(ub.id, targetChannelId);
            joinedAny = true;
          } catch (e) {}
        }
      }

      if (joinedAny) {
        await new Promise(r => setTimeout(r, 1200));
      }

      if (mode === 'queue') {
        userBots.forEach(ub => {
          const b = botManager.bots.get(ub.id);
          const p = lavalink.createPlayer(targetGuildId, {
            accountId: ub.id,
            channelId: targetChannelId,
            userId: b?.client?.user?.id || null,
            ownerId
          });
          p.volume = 1000;
          p.filters.bassboost = true;
          p.queue.push(track);
          lavalink.emit('queueUpdate', p);
          broadcast('playerUpdate', { guildId: targetGuildId, player: p, accountId: ub.id, ownerId }, ownerId);
        });

        return res.json({
          success: true,
          status: 'queued',
          track,
          savedSong,
          url: finalAudioUrl,
          massPlay: true,
          botCount: userBots.length
        });
      }

      // Pre-buffer track for all bots in PAUSED state at 0:00 with 1000% volume & bassboost
      await Promise.allSettled(userBots.map(async (ub) => {
        const b = botManager.bots.get(ub.id);
        const bUid = b?.client?.user?.id || null;
        const p = lavalink.createPlayer(targetGuildId, {
          accountId: ub.id,
          channelId: targetChannelId,
          userId: bUid,
          ownerId
        });
        p.queue = [];
        p.volume = 1000;
        p.filters.bassboost = true;
        if (req.body.loop === true || req.body.loop === 'track') {
          p.loop = 'track';
        } else if (req.body.loop === 'queue') {
          p.loop = 'queue';
        }
        return lavalink.play(targetGuildId, track, {
          accountId: ub.id,
          channelId: targetChannelId,
          userId: bUid,
          ownerId,
          noReplace: false, // Replace current song
          startPaused: true  // Synchronized buffer at 0:00
        });
      }));

      await new Promise(r => setTimeout(r, 180));

      // Simultaneous atomic release
      await Promise.allSettled(userBots.map(async (ub) => {
        const b = botManager.bots.get(ub.id);
        const bUid = b?.client?.user?.id || null;
        const p = lavalink.getPlayer(targetGuildId, ub.id, ownerId);
        if (p) {
          p.paused = false;
          p.playing = true;
          p.position = 0;
        }
        return lavalink.sendPlayerUpdate(targetGuildId, {
          paused: false,
          position: 0
        }, bUid);
      }));

      return res.json({
        success: true,
        status: 'playing',
        track,
        savedSong,
        url: finalAudioUrl,
        massPlay: true,
        botCount: userBots.length
      });
    }

    // Single bot playback fallback
    const targetUserId = targetBot?.client?.user?.id || null;
    const player = lavalink.createPlayer(targetGuildId, {
      accountId: targetBot?.account?.id,
      channelId: targetChannelId,
      userId: targetUserId,
      ownerId
    });
    player.volume = 1000;
    player.filters.bassboost = true;
    if (req.body.loop === true || req.body.loop === 'track') {
      player.loop = 'track';
    } else if (req.body.loop === 'queue') {
      player.loop = 'queue';
    }

    if (mode === 'queue') {
      player.queue.push(track);
      lavalink.emit('queueUpdate', player);
      broadcast('playerUpdate', { guildId: targetGuildId, player, accountId: targetBot?.account?.id, ownerId }, ownerId);
      res.json({ success: true, status: 'queued', track, savedSong, url: finalAudioUrl });
    } else {
      await lavalink.play(targetGuildId, track, {
        noReplace: false,
        accountId: targetBot?.account?.id,
        channelId: targetChannelId,
        userId: targetUserId,
        ownerId
      });
      const updatedPlayer = lavalink.getPlayer(targetGuildId, targetBot?.account?.id, ownerId) || player;
      broadcast('playerUpdate', { guildId: targetGuildId, player: updatedPlayer, accountId: targetBot?.account?.id, ownerId }, ownerId);
      res.json({ success: true, status: 'playing', track, savedSong, url: finalAudioUrl });
    }
  } catch (err) {
    logger.error('AUDIO', `Custom audio error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Saved MP3 Library Endpoints
app.get('/api/music/uploads', (req, res) => {
  const songs = database.getUploadedSongs(req.user.userId);
  res.json({ success: true, songs });
});

app.delete('/api/music/uploads/:id', (req, res) => {
  const removed = database.deleteUploadedSong(req.params.id, req.user.userId);
  if (removed) {
    if (removed.localPath) {
      const p = path.join(__dirname, 'public', removed.localPath);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (e) {}
      }
    }
    return res.json({ success: true, removed });
  }
  res.status(404).json({ success: false, error: 'Song not found' });
});

app.post('/api/music/uploads/:id/play', async (req, res) => {
  try {
    const song = database.getUploadedSongs(req.user.userId).find(s => s.id === req.params.id);
    if (!song) return res.status(404).json({ success: false, error: 'Song not found in your library' });

    // Delegate to custom-audio endpoint with song's URL
    req.body = {
      audioUrl: song.url,
      title: song.title,
      mode: req.body.mode || 'playNow',
      loop: req.body.loop === true || req.body.loop === 'track',
      accountId: 'ALL_BOTS'
    };
    // Re-run handler logic
    const { audioUrl, title, mode, loop } = req.body;
    const ownerId = req.user.userId;
    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');

    let targetGuildId = null;
    let targetChannelId = null;

    for (const ub of userBots) {
      const b = botManager.bots.get(ub.id);
      if (b?.currentVoice?.guildId && b?.currentVoice?.channelId) {
        targetGuildId = b.currentVoice.guildId;
        targetChannelId = b.currentVoice.channelId;
        break;
      }
    }

    if (!targetGuildId || !targetChannelId) {
      const accounts = database.getAccounts(ownerId);
      for (const acc of accounts) {
        if (acc.voice247 && acc.voice247.guildId && acc.voice247.channelId) {
          targetGuildId = acc.voice247.guildId;
          targetChannelId = acc.voice247.channelId;
          break;
        }
      }
    }

    if (!targetGuildId || !targetChannelId) {
      return res.status(400).json({ success: false, error: 'No active voice channel found. Join bots or enable 24/7 first.' });
    }

    let result = await lavalink.loadTracks(audioUrl);
    if ((!result || !result.tracks || result.tracks.length === 0) && song.mirrorUrl) {
      result = await lavalink.loadTracks(song.mirrorUrl);
    }

    if (!result || !result.tracks || result.tracks.length === 0) {
      return res.status(400).json({ success: false, error: 'Could not load audio track from saved URL.' });
    }

    const track = result.tracks[0];
    track.info.title = title || song.title;

    // Synchronize mass play
    await Promise.allSettled(userBots.map(async (ub) => {
      const b = botManager.bots.get(ub.id);
      const bUid = b?.client?.user?.id || null;
      const p = lavalink.createPlayer(targetGuildId, {
        accountId: ub.id,
        channelId: targetChannelId,
        userId: bUid,
        ownerId
      });
      p.queue = [];
      p.volume = 1000;
      p.filters.bassboost = true;
      if (loop) {
        p.loop = 'track';
      }
      return lavalink.play(targetGuildId, track, {
        accountId: ub.id,
        channelId: targetChannelId,
        userId: bUid,
        ownerId,
        noReplace: false,
        startPaused: true
      });
    }));

    await new Promise(r => setTimeout(r, 180));

    await Promise.allSettled(userBots.map(async (ub) => {
      const b = botManager.bots.get(ub.id);
      const bUid = b?.client?.user?.id || null;
      const p = lavalink.getPlayer(targetGuildId, ub.id, ownerId);
      if (p) {
        p.paused = false;
        p.playing = true;
        p.position = 0;
      }
      return lavalink.sendPlayerUpdate(targetGuildId, { paused: false, position: 0 }, bUid);
    }));

    res.json({ success: true, massPlay: true, track, status: 'playing' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/music/player/:guildId', (req, res) => {
  const accountId = req.query.accountId || null;
  const ownerId = req.user.userId;

  let player = null;
  if (accountId && accountId !== 'ALL_BOTS') {
    player = lavalink.getPlayer(req.params.guildId, accountId, ownerId);
  } else {
    for (const p of lavalink.players.values()) {
      if (p.guildId === req.params.guildId && p.ownerId === ownerId) {
        player = p;
        if (p.playing) break;
      }
    }
  }

  if (player && player.ownerId && player.ownerId !== ownerId) {
    return res.json({ success: true, player: null });
  }
  res.json({ success: true, player: player || null });
});

app.post('/api/music/player/:guildId/play', async (req, res) => {
  try {
    const { track, accountId, channelId } = req.body;
    if (!track) return res.status(400).json({ success: false, error: 'Track payload required' });
    const ownerId = req.user.userId;

    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
    const isSingle = req.body.singleBot === true;
    const isMass = !isSingle;

    if (isMass) {
      if (userBots.length === 0) {
        return res.status(400).json({ success: false, error: 'No online bots found under your account to play music' });
      }

      // Auto-detect target voice channel if not passed explicitly
      let targetVcId = channelId;
      if (!targetVcId) {
        for (const ub of userBots) {
          const b = botManager.bots.get(ub.id);
          if (b && b.currentVoice?.guildId === req.params.guildId && b.currentVoice?.channelId) {
            targetVcId = b.currentVoice.channelId;
            break;
          }
        }
      }

      logger.music('MASS_PLAY', `User [${req.user.username}] synchronized mass play: "${track.info?.title}" across ${userBots.length} bots in channel ${targetVcId || 'current'}`);

      // 1. Ensure all online bots join the selected voice channel
      let joinedAny = false;
      for (const ub of userBots) {
        const bot = botManager.bots.get(ub.id);
        if (bot && targetVcId && bot.currentVoice?.channelId !== targetVcId) {
          try {
            await botManager.joinVoice(ub.id, targetVcId);
            joinedAny = true;
          } catch (e) {}
        }
      }

      // If any bot joined, allow 1200ms for voice UDP handshakes to fully establish
      if (joinedAny) {
        await new Promise(r => setTimeout(r, 1200));
      }

      // 2. Pre-buffer track for all online bots in PAUSED state at 0:00
      // Synchronize player queue, volume (1000%), and bassboost across all bots
      await Promise.allSettled(userBots.map(async (ub) => {
        const bot = botManager.bots.get(ub.id);
        const userId = bot?.client?.user?.id || null;
        const player = lavalink.createPlayer(req.params.guildId, {
          accountId: ub.id,
          channelId: targetVcId,
          userId,
          ownerId
        });
        player.queue = [];
        player.volume = 1000;
        player.filters.bassboost = true;
        return lavalink.play(req.params.guildId, track, {
          accountId: ub.id,
          channelId: targetVcId,
          userId,
          ownerId,
          noReplace: true,
          startPaused: true // Pre-buffer at 0:00
        });
      }));

      // 3. Buffer completion barrier (180ms)
      await new Promise(r => setTimeout(r, 180));

      // 4. Atomic release barrier: unpause all bots at position 0 simultaneously
      await Promise.allSettled(userBots.map(async (ub) => {
        const bot = botManager.bots.get(ub.id);
        const userId = bot?.client?.user?.id || null;
        const player = lavalink.getPlayer(req.params.guildId, ub.id, ownerId);
        if (player) {
          player.paused = false;
          player.playing = true;
          player.position = 0;
        }
        return lavalink.sendPlayerUpdate(req.params.guildId, {
          paused: false,
          position: 0
        }, userId);
      }));

      return res.json({ success: true, massPlay: true, count: userBots.length, result: { status: 'playing', track } });
    }

    let userId = null;
    if (accountId) {
      const bot = botManager.bots.get(accountId);
      if (bot && bot.account && bot.account.ownerId && bot.account.ownerId !== ownerId) {
        return res.status(403).json({ success: false, error: 'Unauthorized bot access' });
      }
      if (bot?.client?.user) userId = bot.client.user.id;
      if (bot && channelId && bot.currentVoice?.channelId !== channelId) {
        try {
          await botManager.joinVoice(accountId, channelId);
          await new Promise(r => setTimeout(r, 900));
        } catch (vErr) {
          logger.warn('BOT', `Auto-join voice warning: ${vErr.message}`);
        }
      }
    }
    const result = await lavalink.play(req.params.guildId, track, {
      accountId,
      channelId,
      userId,
      ownerId,
      noReplace: true
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/playlist', async (req, res) => {
  try {
    const { tracks, accountId, channelId } = req.body;
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
      return res.status(400).json({ success: false, error: 'Tracks array required' });
    }
    const ownerId = req.user.userId;
    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
    const isSingle = req.body.singleBot === true;
    const isMass = !isSingle;

    if (isMass) {
      let targetVcId = channelId;
      if (!targetVcId) {
        for (const ub of userBots) {
          const b = botManager.bots.get(ub.id);
          if (b && b.currentVoice?.guildId === req.params.guildId && b.currentVoice?.channelId) {
            targetVcId = b.currentVoice.channelId;
            break;
          }
        }
      }

      let joinedAny = false;
      for (const ub of userBots) {
        const bot = botManager.bots.get(ub.id);
        if (bot && targetVcId && bot.currentVoice?.channelId !== targetVcId) {
          try {
            await botManager.joinVoice(ub.id, targetVcId);
            joinedAny = true;
          } catch (e) {}
        }
      }

      if (joinedAny) {
        await new Promise(r => setTimeout(r, 1200));
      }

      const firstTrack = tracks[0];
      const restTracks = tracks.slice(1);

      // Pre-buffer first track paused for all bots and give them identical queues
      await Promise.allSettled(userBots.map(async (ub) => {
        const bot = botManager.bots.get(ub.id);
        const userId = bot?.client?.user?.id || null;
        const player = lavalink.createPlayer(req.params.guildId, {
          accountId: ub.id,
          channelId,
          userId,
          ownerId
        });
        player.queue = [...restTracks];
        player.volume = 1000;
        player.filters.bassboost = true;
        return lavalink.play(req.params.guildId, firstTrack, {
          accountId: ub.id,
          channelId,
          userId,
          ownerId,
          noReplace: true,
          startPaused: true
        });
      }));

      await new Promise(r => setTimeout(r, 180));

      // Atomic release barrier
      await Promise.allSettled(userBots.map(async (ub) => {
        const bot = botManager.bots.get(ub.id);
        const userId = bot?.client?.user?.id || null;
        const player = lavalink.getPlayer(req.params.guildId, ub.id, ownerId);
        if (player) {
          player.paused = false;
          player.playing = true;
          player.position = 0;
        }
        return lavalink.sendPlayerUpdate(req.params.guildId, {
          paused: false,
          position: 0
        }, userId);
      }));

      return res.json({ success: true, count: tracks.length, massPlay: true, botCount: userBots.length });
    }

    let userId = null;
    if (accountId) {
      const bot = botManager.bots.get(accountId);
      if (bot && bot.account && bot.account.ownerId && bot.account.ownerId !== ownerId) {
        return res.status(403).json({ success: false, error: 'Unauthorized bot access' });
      }
      if (bot?.client?.user) userId = bot.client.user.id;
      if (bot && channelId && bot.currentVoice?.channelId !== channelId) {
        try {
          await botManager.joinVoice(accountId, channelId);
          await new Promise(r => setTimeout(r, 900));
        } catch (vErr) {
          logger.warn('BOT', `Auto-join voice warning: ${vErr.message}`);
        }
      }
    }
    await lavalink.addPlaylist(req.params.guildId, tracks, { accountId, channelId, userId, ownerId, noReplace: true });
    res.json({ success: true, count: tracks.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/pause', async (req, res) => {
  try {
    const { paused, accountId } = req.body;
    const ownerId = req.user.userId;
    if (accountId === 'ALL_BOTS' || !accountId) {
      for (const p of lavalink.players.values()) {
        if (p.guildId === req.params.guildId && p.ownerId === ownerId) {
          await lavalink.pause(req.params.guildId, paused !== false, p.accountId, ownerId);
        }
      }
    } else {
      await lavalink.pause(req.params.guildId, paused !== false, accountId, ownerId);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/skip', async (req, res) => {
  try {
    const { accountId } = req.body;
    const ownerId = req.user.userId;
    if (accountId === 'ALL_BOTS' || !accountId) {
      for (const p of lavalink.players.values()) {
        if (p.guildId === req.params.guildId && p.ownerId === ownerId) {
          await lavalink.skip(req.params.guildId, p.accountId, ownerId);
        }
      }
    } else {
      await lavalink.skip(req.params.guildId, accountId, ownerId);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/stop', async (req, res) => {
  try {
    const { accountId } = req.body;
    const ownerId = req.user.userId;
    if (accountId === 'ALL_BOTS' || !accountId) {
      for (const p of lavalink.players.values()) {
        if (p.guildId === req.params.guildId && p.ownerId === ownerId) {
          await lavalink.stop(req.params.guildId, p.accountId, ownerId);
        }
      }
    } else {
      await lavalink.stop(req.params.guildId, accountId, ownerId);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/volume', async (req, res) => {
  try {
    const { volume, accountId } = req.body;
    const ownerId = req.user.userId;
    const vol = parseInt(volume, 10) || 1000;
    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
    if (accountId === 'ALL_BOTS' || !accountId || req.body.allBots === true) {
      await Promise.allSettled(userBots.map(async (ub) => {
        return lavalink.setVolume(req.params.guildId, vol, ub.id, ownerId);
      }));
    } else {
      await lavalink.setVolume(req.params.guildId, vol, accountId, ownerId);
    }
    res.json({ success: true, volume: vol });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/seek', async (req, res) => {
  try {
    const { position, accountId } = req.body;
    const ownerId = req.user.userId;
    const pos = Math.max(0, parseInt(position, 10) || 0);
    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
    if (accountId === 'ALL_BOTS' || !accountId || req.body.allBots === true) {
      await Promise.allSettled(userBots.map(async (ub) => {
        const bot = botManager.bots.get(ub.id);
        const userId = bot?.client?.user?.id || null;
        const player = lavalink.getPlayer(req.params.guildId, ub.id, ownerId);
        if (player) player.position = pos;
        return lavalink.sendPlayerUpdate(req.params.guildId, { position: pos }, userId);
      }));
    } else {
      await lavalink.seek(req.params.guildId, pos, accountId, ownerId);
    }
    res.json({ success: true, position: pos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/sync', async (req, res) => {
  try {
    const ownerId = req.user.userId;
    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
    if (userBots.length === 0) return res.status(400).json({ success: false, error: 'No online bots' });

    let leadPlayer = null;
    for (const ub of userBots) {
      const p = lavalink.getPlayer(req.params.guildId, ub.id, ownerId);
      if (p && p.currentTrack && p.playing) {
        leadPlayer = p;
        break;
      }
    }

    if (!leadPlayer || !leadPlayer.currentTrack) {
      return res.status(400).json({ success: false, error: 'No bot is currently playing a track to sync from' });
    }

    const track = leadPlayer.currentTrack;
    const pos = Math.max(0, leadPlayer.position || 0);
    const filtersPayload = lavalink.buildFiltersPayload(leadPlayer);

    // Atomically snap all bots to exact same track, position, volume, and EQ
    await Promise.allSettled(userBots.map(async (ub) => {
      const bot = botManager.bots.get(ub.id);
      const userId = bot?.client?.user?.id || null;
      const p = lavalink.getPlayer(req.params.guildId, ub.id, ownerId);
      if (p) {
        p.currentTrack = track;
        p.position = pos;
        p.playing = true;
        p.paused = false;
        p.volume = leadPlayer.volume;
      }
      return lavalink.sendPlayerUpdate(req.params.guildId, {
        track: { encoded: track.encoded },
        position: pos,
        paused: false,
        volume: Math.min(1000, leadPlayer.volume),
        filters: filtersPayload
      }, userId);
    }));

    res.json({ success: true, syncedBots: userBots.length, position: pos, track: track.info?.title });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/loop', (req, res) => {
  const { mode, accountId } = req.body; // 'off', 'track', 'queue'
  const ownerId = req.user.userId;
  const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
  if (accountId === 'ALL_BOTS' || !accountId) {
    for (const ub of userBots) {
      lavalink.setLoop(req.params.guildId, mode, ub.id, ownerId);
    }
  } else {
    lavalink.setLoop(req.params.guildId, mode, accountId, ownerId);
  }
  res.json({ success: true, mode });
});

// Global loop toggle across all active voice bots & guilds
app.post('/api/music/loop/all', (req, res) => {
  const { mode } = req.body; // 'off', 'track', 'queue'
  const ownerId = req.user.userId;
  const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
  const targetGuilds = new Set();
  for (const ub of userBots) {
    if (ub.currentVoice?.guildId) targetGuilds.add(ub.currentVoice.guildId);
  }
  for (const guildId of targetGuilds) {
    lavalink.setLoop(guildId, mode || 'track', 'ALL_BOTS', ownerId);
  }
  res.json({ success: true, mode: mode || 'track', updatedGuilds: Array.from(targetGuilds) });
});

app.post('/api/music/player/:guildId/filter', async (req, res) => {
  try {
    const { filterName, enabled, accountId } = req.body;
    const ownerId = req.user.userId;
    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
    if (accountId === 'ALL_BOTS' || !accountId || req.body.allBots === true) {
      await Promise.allSettled(userBots.map(async (ub) => {
        return lavalink.applyFilters(req.params.guildId, filterName, !!enabled, ub.id, ownerId);
      }));
    } else {
      await lavalink.applyFilters(req.params.guildId, filterName, !!enabled, accountId, ownerId);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/music/player/:guildId/queue/:index', (req, res) => {
  const accountId = req.query.accountId || req.body?.accountId || null;
  const removed = lavalink.removeQueueTrack(req.params.guildId, parseInt(req.params.index, 10), accountId, req.user.userId);
  res.json({ success: true, removed });
});

app.delete('/api/music/player/:guildId/queue', (req, res) => {
  const accountId = req.query.accountId || req.body?.accountId || null;
  lavalink.clearQueue(req.params.guildId, accountId, req.user.userId);
  res.json({ success: true });
});

// 4. Logs API
app.get('/api/logs', (req, res) => {
  res.json({ success: true, logs: logger.getRecentLogs(200) });
});

app.post('/api/logs/clear', (req, res) => {
  logger.clear();
  res.json({ success: true });
});

// 5. Settings API
app.get('/api/settings', (req, res) => {
  res.json({ success: true, settings: database.getSettings() });
});

app.post('/api/settings', (req, res) => {
  const updated = database.updateSettings(req.body);
  res.json({ success: true, settings: updated });
});

// WebSocket Connection Handling with User Isolation
wss.on('connection', (ws) => {
  logger.info('WS', 'New dashboard client connected');

  ws.on('message', (message, isBinary) => {
    try {
      const parsed = JSON.parse(message.toString());
      if (parsed.type === 'auth' && parsed.token) {
        const session = authManager.verifySession(parsed.token);
        if (session) {
          ws.userId = session.userId;
          ws.username = session.username;
          // Send user-isolated initial data
          ws.send(JSON.stringify({
            type: 'init',
            data: {
              accounts: botManager.getAllBotsStatus(session.userId),
              lavalink: {
                name: lavalink.name,
                host: lavalink.host,
                port: lavalink.port,
                secure: lavalink.secure,
                connected: lavalink.connected,
                stats: lavalink.stats
              },
              settings: database.getSettings()
            }
          }));
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    // Client disconnected
  });
});

// Handle process and server errors gracefully
process.on('uncaughtException', (err) => {
  logger.error('CRASH', `Uncaught Exception: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('CRASH', `Unhandled Rejection: ${reason}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error('SERVER', `Port ${config.port} is already in use by another program!`);
    console.log(`\n\x1b[31m[ERROR] Port ${config.port} is already in use!\x1b[0m`);
    console.log(`Make sure no other instance of the bot dashboard is currently running.\n`);
  } else {
    logger.error('SERVER', `Server error: ${err.message}`);
  }
});

// Start Web Server

// ══════════════════════════════════════════════════════════════════
// EXACT COMMAND & VOLUME/BASS CONTROLLER (from dashboard & dashboard sb html)
// ══════════════════════════════════════════════════════════════════
let currentVolumeMultiplier = 100.0; // 10000% default
let isBassboosted = true;
let blastMode = false;
let blastVolume = 50.0;
let superLoudMode = false;
let forceLoudMode = false;
let pungiMode = false;
let pungiIntensity = 50.0;
let loudMode = false;
let loopMode = false;
let isPaused = false;
let currentTitle = "Nothing playing";

app.get('/api/status', (req, res) => {
  const userId = req.user?.userId || null;
  const onlineBots = botManager.getAllBotsStatus(userId).filter(b => b.status === 'online');
  res.json({
    isRunning: onlineBots.length > 0,
    botCount: onlineBots.length,
    currentTitle: currentTitle,
    volume: Math.round(currentVolumeMultiplier * 100),
    isPaused, loopMode, isBassboosted, blastMode, pungiMode, loudMode, superLoudMode, forceLoudMode,
    connected: onlineBots.some(b => b.currentVoice?.channelId)
  });
});

app.post('/api/command', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.json({ error: 'No command' });

  const userId = req.user?.userId || null;
  const userBots = botManager.getAllBotsStatus(userId).filter(b => b.status === 'online');
  const targetGuilds = new Set();
  userBots.forEach(b => {
    if (b.currentVoice?.guildId) targetGuilds.add(b.currentVoice.guildId);
  });
  if (targetGuilds.size === 0 && lavalink.players.size > 0) {
    for (const [k, p] of lavalink.players.entries()) {
      if (p.guildId && (!userId || p.ownerId === userId)) targetGuilds.add(p.guildId);
    }
  }

  const lowerCmd = command.toLowerCase().trim();
  let response = '';

  try {
    if (lowerCmd === 'help') {
      response = 'Commands: play <url>, volume <1-20000>, max, blast, doubleblast, superloud, forceloud, bassboost, pungi, pungiset, loudmode, loop, pause, resume, stop, leave, status';
    }
    else if (lowerCmd.startsWith('play ')) {
      const query = command.slice(5).trim();
      if (userBots.length === 0) {
        response = '❌ No bots online!';
      } else {
        const results = await lavalink.searchTracks(query);
        if (!results.tracks || results.tracks.length === 0) {
          response = '❌ No audio tracks found for query.';
        } else {
          const track = results.tracks[0];
          currentTitle = track.info.title || query;
          isPaused = false;
          let played = 0;
          for (const guildId of targetGuilds) {
            await lavalink.playTrack(guildId, track, 'ALL_BOTS', userId);
            played++;
          }
          response = `▶️ Now Playing: ${currentTitle} across ${played || userBots.length} bots`;
        }
      }
    }
    else if (lowerCmd === 'stop') {
      for (const guildId of targetGuilds) {
        await lavalink.stopTrack(guildId, 'ALL_BOTS', userId);
      }
      currentTitle = "Nothing playing";
      isPaused = false;
      response = '⏹️ Playback stopped';
    }
    else if (lowerCmd === 'pause') {
      for (const guildId of targetGuilds) {
        await lavalink.pause(guildId, true, 'ALL_BOTS', userId);
      }
      isPaused = true;
      response = '⏸️ Paused';
    }
    else if (lowerCmd === 'resume') {
      for (const guildId of targetGuilds) {
        await lavalink.pause(guildId, false, 'ALL_BOTS', userId);
      }
      isPaused = false;
      response = '▶️ Resumed';
    }
    else if (lowerCmd === 'leave') {
      await botManager.leaveAllVoice(userId, false);
      for (const guildId of targetGuilds) {
        await lavalink.stopTrack(guildId, 'ALL_BOTS', userId);
      }
      currentTitle = "Nothing playing";
      response = '👋 Disconnected all bots';
    }
    else if (lowerCmd.startsWith('volume ')) {
      const vol = parseInt(command.slice(7).trim(), 10);
      if (isNaN(vol) || vol < 1 || vol > 20000) {
        response = '❌ Volume must be 1-20000%';
      } else {
        currentVolumeMultiplier = vol / 100;
        for (const guildId of targetGuilds) {
          await lavalink.setVolume(guildId, vol, 'ALL_BOTS', userId);
        }
        response = `🔊 Volume set to ${vol}%`;
      }
    }
    else if (lowerCmd === 'max') {
      currentVolumeMultiplier = 100.0;
      for (const guildId of targetGuilds) {
        await lavalink.setVolume(guildId, 10000, 'ALL_BOTS', userId);
      }
      response = '💥 MAXIMUM VOLUME (10000%)';
    }
    else if (lowerCmd === 'blast') {
      blastMode = !blastMode;
      pungiMode = false; superLoudMode = false; forceLoudMode = false;
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'blast', blastMode, 'ALL_BOTS', userId);
        await lavalink.applyFilters(guildId, 'pungi', false, 'ALL_BOTS', userId);
        await lavalink.applyFilters(guildId, 'superLoud', false, 'ALL_BOTS', userId);
        await lavalink.applyFilters(guildId, 'forceLoud', false, 'ALL_BOTS', userId);
      }
      response = `🔥 Blast Mode ${blastMode ? 'ACTIVATED' : 'DEACTIVATED'}`;
    }
    else if (lowerCmd === 'doubleblast') {
      blastMode = true; pungiMode = false; superLoudMode = false; forceLoudMode = false;
      blastVolume = 100.0; currentVolumeMultiplier = 100.0;
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'doubleblast', true, 'ALL_BOTS', userId);
        await lavalink.applyFilters(guildId, 'blast', true, 'ALL_BOTS', userId);
        await lavalink.setVolume(guildId, 10000, 'ALL_BOTS', userId);
      }
      response = '💥💥 DOUBLE BLAST ACTIVATED!';
    }
    else if (lowerCmd === 'superloud') {
      superLoudMode = !superLoudMode;
      if (superLoudMode) { blastMode = false; pungiMode = false; forceLoudMode = false; }
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'superLoud', superLoudMode, 'ALL_BOTS', userId);
      }
      response = `🔊 Super Loud ${superLoudMode ? 'ACTIVATED' : 'DEACTIVATED'}`;
    }
    else if (lowerCmd === 'forceloud') {
      forceLoudMode = !forceLoudMode;
      if (forceLoudMode) { blastMode = false; pungiMode = false; superLoudMode = false; }
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'forceLoud', forceLoudMode, 'ALL_BOTS', userId);
      }
      response = `🔥 Force Loud ${forceLoudMode ? 'ACTIVATED' : 'DEACTIVATED'}`;
    }
    else if (lowerCmd === 'bassboost') {
      isBassboosted = !isBassboosted;
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'bassboost', isBassboosted, 'ALL_BOTS', userId);
      }
      response = `🎵 Bassboost ${isBassboosted ? 'ENABLED' : 'DISABLED'}`;
    }
    else if (lowerCmd === 'pungi') {
      pungiMode = !pungiMode;
      blastMode = false; superLoudMode = false; forceLoudMode = false;
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'pungi', pungiMode, 'ALL_BOTS', userId);
      }
      response = `🐍 Pungi Mode ${pungiMode ? 'ACTIVATED' : 'DEACTIVATED'}`;
    }
    else if (lowerCmd.startsWith('pungiset ')) {
      const val = parseFloat(command.slice(9).trim());
      if (isNaN(val) || val < 1 || val > 200) {
        response = '❌ Intensity must be 1-200';
      } else {
        pungiIntensity = val;
        pungiMode = true;
        for (const guildId of targetGuilds) {
          await lavalink.applyFilters(guildId, 'pungi', true, 'ALL_BOTS', userId);
        }
        response = `🐍 Pungi intensity set to ${val}x`;
      }
    }
    else if (lowerCmd === 'loudmode') {
      loudMode = !loudMode;
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'loudMode', loudMode, 'ALL_BOTS', userId);
      }
      response = `🔊 Loud Mode ${loudMode ? 'ENABLED' : 'DISABLED'}`;
    }
    else if (lowerCmd === 'loop') {
      loopMode = !loopMode;
      const modeStr = loopMode ? 'track' : 'none';
      for (const guildId of targetGuilds) {
        lavalink.setLoop(guildId, modeStr, 'ALL_BOTS', userId);
      }
      response = `🔄 Loop ${loopMode ? 'ENABLED' : 'DISABLED'}`;
    }
    else if (lowerCmd === 'status') {
      response = `🎵 ${currentTitle}\n📊 ${userBots.length} bots online\n🔊 ${Math.round(currentVolumeMultiplier * 100)}%\n🔄 Loop: ${loopMode ? 'ON' : 'OFF'}`;
    }
    else if (!isNaN(lowerCmd) && lowerCmd.length >= 10) {
      const channelId = lowerCmd;
      const resJoin = await botManager.joinAllToVoice(userId, channelId, { selfMute: false, selfDeaf: false });
      response = `✅ Connected ${resJoin.count || userBots.length} bots to channel ${channelId}`;
    }
    else {
      response = '❌ Unknown command. Type "help" for list.';
    }
  } catch (err) {
    response = `❌ Error: ${err.message}`;
  }

  res.json({ response, currentVolume: Math.round(currentVolumeMultiplier * 100), isBassboosted, blastMode, superLoudMode, forceLoudMode, pungiMode, loudMode, loopMode });
});

server.listen(config.port, config.host, () => {
  logger.success('SERVER', `╔═════════════════════════════════════════════════════════════╗`);
  logger.success('SERVER', `║  🎵 MULTI-ACCOUNT DISCORD SELFBOT & LAVALINK DASHBOARD 🎵  ║`);
  logger.success('SERVER', `╠═════════════════════════════════════════════════════════════╣`);
  logger.success('SERVER', `║  Dashboard Web UI: http://localhost:${config.port}                   ║`);
  logger.success('SERVER', `║  Lavalink Node:    ${lavalink.name} (${lavalink.host}:${lavalink.port})      ║`);
  logger.success('SERVER', `╚═════════════════════════════════════════════════════════════╝`);

  // Auto-start enabled accounts
  botManager.startAll().catch(e => {
    logger.error('BOT', `Error auto-starting accounts: ${e.message}`);
  });
});
