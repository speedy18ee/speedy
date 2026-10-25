require('./src/patch');
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const config = require('./src/config');
const database = require('./src/database');
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

// 1. Accounts API (Strictly Partitioned by User Credentials)
app.get('/api/accounts', (req, res) => {
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
    
    // Find target bot
    let targetBot = null;
    if (accountId) {
      targetBot = botManager.bots.get(accountId);
    } else {
      // Find first online bot belonging to this user
      const userBots = botManager.getAllBotsStatus(req.user?.userId);
      for (const ub of userBots) {
        if (ub.status === 'online') {
          targetBot = botManager.bots.get(ub.id);
          if (targetBot?.currentVoice?.guildId) break;
        }
      }
      if (!targetBot) {
        for (const [id, bot] of botManager.bots.entries()) {
          if (bot.account?.ownerId === req.user?.userId && bot.status === 'online') {
            targetBot = bot;
            if (bot.currentVoice?.guildId) break;
          }
        }
      }
    }

    let targetGuildId = guildId || targetBot?.currentVoice?.guildId;
    let targetChannelId = channelId || targetBot?.currentVoice?.channelId;

    if (!targetGuildId) {
      return res.status(400).json({
        success: false,
        error: 'No voice channel found. Please choose a bot and connect it to a voice channel first.'
      });
    }

    let finalAudioUrl = rawAudioUrl;

    if (!finalAudioUrl && audioBase64) {
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      const isMp3 = filename?.toLowerCase().endsWith('.mp3');
      const ext = isMp3 ? '.mp3' : '.wav';
      const safeFilename = (filename || `audio_${Date.now()}${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_');
      const localFilePath = path.join(__dirname, 'public', 'uploads', `${Date.now()}_${safeFilename}`);
      
      try {
        fs.writeFileSync(localFilePath, audioBuffer);
      } catch (fErr) {
        logger.warn('AUDIO', `Local cache write warning: ${fErr.message}`);
      }

      // Upload to Catbox
      try {
        const mimeType = isMp3 ? 'audio/mpeg' : 'audio/wav';
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', new Blob([audioBuffer], { type: mimeType }), safeFilename);
        const catRes = await fetch('https://catbox.moe/user/api.php', {
          method: 'POST',
          body: form,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        const urlText = await catRes.text();
        if (urlText && urlText.trim().startsWith('http')) {
          finalAudioUrl = urlText.trim();
          logger.success('AUDIO', `Audio file uploaded to Catbox: ${finalAudioUrl}`);
        }
      } catch (catErr) {
        logger.warn('AUDIO', `Catbox upload error: ${catErr.message}`);
      }
    }

    if (!finalAudioUrl) {
      return res.status(400).json({
        success: false,
        error: 'Could not process audio. Please provide a valid MP3 file or audio recording.'
      });
    }

    // Auto-join voice channel if not currently in target channel
    if (targetBot && targetChannelId && targetBot.currentVoice?.channelId !== targetChannelId) {
      try {
        await botManager.joinVoice(targetBot.account.id, targetChannelId);
        await new Promise(r => setTimeout(r, 800));
      } catch (vErr) {
        logger.warn('BOT', `Auto-join voice warning: ${vErr.message}`);
      }
    }

    // Load track via Lavalink
    const result = await lavalink.loadTracks(finalAudioUrl);
    if (!result || !result.tracks || result.tracks.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Lavalink could not load this audio track. Please ensure the audio is valid MP3 or WAV.'
      });
    }

    const track = result.tracks[0];
    const displayTitle = title || filename || (finalAudioUrl.includes('.mp3') ? 'Custom MP3 Audio' : 'Recorded Voice Note');
    track.info.title = displayTitle;
    track.info.author = finalAudioUrl.includes('.mp3') ? 'Uploaded MP3' : 'Voice Recording';

    const userId = targetBot?.client?.user?.id || null;
    const ownerId = req.user.userId;
    const isMass = accountId === 'ALL_BOTS' || !accountId || req.body.allBots === true;

    if (isMass) {
      const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
      if (userBots.length === 0) {
        return res.status(400).json({ success: false, error: 'No online bots found under your credentials' });
      }

      logger.music('MASS_PLAY', `User [${req.user.username}] triggering ALL BOTS (${userBots.length}) audio playback: "${displayTitle}"`);

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
        await new Promise(r => setTimeout(r, 1000));
      }

      const massPromises = userBots.map(async (ub) => {
        const b = botManager.bots.get(ub.id);
        const bUid = b?.client?.user?.id || null;
        const p = lavalink.createPlayer(targetGuildId, {
          accountId: ub.id,
          channelId: targetChannelId,
          userId: bUid,
          ownerId
        });

        if (mode === 'queue') {
          p.queue.push(track);
          lavalink.emit('queueUpdate', p);
          broadcast('playerUpdate', { guildId: targetGuildId, player: p, accountId: ub.id, ownerId }, ownerId);
        } else {
          await lavalink.play(targetGuildId, track, {
            noReplace: true,
            accountId: ub.id,
            channelId: targetChannelId,
            userId: bUid,
            ownerId
          });
          const updated = lavalink.getPlayer(targetGuildId, ub.id, ownerId) || p;
          broadcast('playerUpdate', { guildId: targetGuildId, player: updated, accountId: ub.id, ownerId }, ownerId);
        }
      });

      await Promise.allSettled(massPromises);
      return res.json({
        success: true,
        status: mode === 'queue' ? 'queued' : 'playing',
        track,
        url: finalAudioUrl,
        massPlay: true,
        botCount: userBots.length
      });
    }

    const player = lavalink.createPlayer(targetGuildId, {
      accountId: targetBot?.account?.id,
      channelId: targetChannelId,
      userId,
      ownerId
    });

    if (mode === 'queue') {
      player.queue.push(track);
      lavalink.emit('queueUpdate', player);
      broadcast('playerUpdate', { guildId: targetGuildId, player, accountId: targetBot?.account?.id, ownerId }, ownerId);
      logger.music('QUEUE', `Added "${displayTitle}" to queue for [${targetBot?.account?.label || targetGuildId}]`);
      res.json({ success: true, status: 'queued', track, url: finalAudioUrl });
    } else {
      // Immediate playback
      await lavalink.play(targetGuildId, track, {
        noReplace: true,
        accountId: targetBot?.account?.id,
        channelId: targetChannelId,
        userId,
        ownerId
      });
      const updatedPlayer = lavalink.getPlayer(targetGuildId, targetBot?.account?.id, ownerId) || player;
      broadcast('playerUpdate', { guildId: targetGuildId, player: updatedPlayer, accountId: targetBot?.account?.id, ownerId }, ownerId);
      logger.music('PLAY', `Playing custom audio "${displayTitle}" on [${targetBot?.account?.label || targetGuildId}]`);
      res.json({ success: true, status: 'playing', track, url: finalAudioUrl });
    }
  } catch (err) {
    logger.error('AUDIO', `Custom audio error: ${err.message}`);
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
    const isMass = accountId === 'ALL_BOTS' || !accountId || req.body.allBots === true;

    if (isMass) {
      if (userBots.length === 0) {
        return res.status(400).json({ success: false, error: 'No online bots found under your account to play music' });
      }

      logger.music('MASS_PLAY', `User [${req.user.username}] synchronized mass play: "${track.info?.title}" across ${userBots.length} bots`);

      // 1. Ensure all online bots join the selected voice channel
      let joinedAny = false;
      for (const ub of userBots) {
        const bot = botManager.bots.get(ub.id);
        if (bot && channelId && bot.currentVoice?.channelId !== channelId) {
          try {
            await botManager.joinVoice(ub.id, channelId);
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
          channelId,
          userId,
          ownerId
        });
        player.queue = [];
        player.volume = 1000;
        player.filters.bassboost = true;
        return lavalink.play(req.params.guildId, track, {
          accountId: ub.id,
          channelId,
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
    const isMass = accountId === 'ALL_BOTS' || !accountId || req.body.allBots === true;

    if (isMass) {
      let joinedAny = false;
      for (const ub of userBots) {
        const bot = botManager.bots.get(ub.id);
        if (bot && channelId && bot.currentVoice?.channelId !== channelId) {
          try {
            await botManager.joinVoice(ub.id, channelId);
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
  res.json({ success: true });
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
