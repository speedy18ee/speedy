const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

class Database {
  constructor() {
    this.ensureDirs();
    this.accounts = this.loadJSON(config.accountsFile, []);

    // Rehydrate from Render Cloud PERSISTENT_ACCOUNTS environment variable if present
    const envAccountsRaw = process.env.PERSISTENT_ACCOUNTS || process.env.ACCOUNTS_DATA;
    if (envAccountsRaw) {
      try {
        const envAccounts = JSON.parse(envAccountsRaw);
        if (Array.isArray(envAccounts)) {
          let mergedCount = 0;
          for (const a of envAccounts) {
            if (!a || !a.token) continue;
            const existing = this.accounts.find(x => x.id === a.id || x.token === a.token);
            if (!existing) {
              this.accounts.push(a);
              mergedCount++;
            } else {
              if (a.voice247) existing.voice247 = a.voice247;
              if (a.ownerId) existing.ownerId = a.ownerId;
              if (a.ownerUsername) existing.ownerUsername = a.ownerUsername;
            }
          }
          if (mergedCount > 0) {
            logger.info('DB', `Merged ${mergedCount} persistent bot account(s) from Render Cloud environment.`);
            this.saveJSON(config.accountsFile, this.accounts, false);
          }
        }
      } catch (e) {
        logger.error('DB', `Error parsing PERSISTENT_ACCOUNTS env var: ${e.message}`);
      }
    }

    this.settings = this.loadJSON(config.settingsFile, {
      lavalink: config.defaultNode,
      webPort: config.port,
      autoReconnectVoice: true,
      reconnectIntervalSec: 5
    });
  }

  ensureDirs() {
    if (!fs.existsSync(config.dataDir)) {
      fs.mkdirSync(config.dataDir, { recursive: true });
    }
  }

  loadJSON(filePath, fallback) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      logger.error('DB', `Failed to read ${filePath}: ${err.message}`);
    }
    return fallback;
  }

  saveJSON(filePath, data, triggerSync = true) {
    try {
      this.ensureDirs();
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
      if (triggerSync && filePath === config.accountsFile) {
        try {
          const cloudSync = require('./cloudSync');
          cloudSync.scheduleSync(4000);
        } catch (e) {}
      }
      return true;
    } catch (err) {
      logger.error('DB', `Failed to write ${filePath}: ${err.message}`);
      return false;
    }
  }

  // --- Account methods ---
  getAccounts(userId = null) {
    if (!userId) return this.accounts;
    return this.accounts.filter(a => a.ownerId === userId);
  }

  getAccount(id, userId = null) {
    const acc = this.accounts.find(a => a.id === id);
    if (!acc) return null;
    if (userId && acc.ownerId !== userId) return null;
    return acc;
  }

  addAccount({ token, label = 'Selfbot Account', autoStart = true, ownerId = 'default', ownerUsername = '' }) {
    // Check if token already exists for THIS user
    const cleanToken = token.trim().replace(/^"|"$/g, '');
    const existing = this.accounts.find(a => a.token === cleanToken && a.ownerId === ownerId);
    if (existing) {
      throw new Error('This account token is already added to your dashboard.');
    }

    // Check if the underlying Discord user ID is already added under another token
    const tokenPart = cleanToken.split('.')[0];
    try {
      const decodedUid = Buffer.from(tokenPart, 'base64').toString('utf8');
      if (/^\d{17,20}$/.test(decodedUid)) {
        const dupUser = this.accounts.find(a => {
          if (a.ownerId !== ownerId) return false;
          if (a.lastKnownUser?.id === decodedUid) return true;
          const aPart = (a.token || '').split('.')[0];
          try {
            return Buffer.from(aPart, 'base64').toString('utf8') === decodedUid;
          } catch (_) { return false; }
        });
        if (dupUser) {
          throw new Error(`This token belongs to "${dupUser.label || dupUser.lastKnownUser?.username || decodedUid}", which is already in your dashboard! Discord only allows one voice connection per user account.`);
        }
      }
    } catch (_) {}

    const newAcc = {
      id: 'acc_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      ownerId: ownerId,
      ownerUsername: ownerUsername,
      token: cleanToken,
      label: label.trim() || 'Selfbot Account',
      autoStart: autoStart !== false,
      status: 'online',
      activity: {
        type: 'PLAYING',
        name: '24/7 Music'
      },
      voice247: {
        enabled: false,
        guildId: '',
        guildName: '',
        channelId: '',
        channelName: '',
        selfMute: false,
        selfDeaf: false
      },
      lastKnownUser: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.accounts.push(newAcc);
    this.saveJSON(config.accountsFile, this.accounts);
    try {
      const mongoDb = require('./mongoDb');
      mongoDb.saveAccount(newAcc).catch(() => {});
    } catch (_) {}
    return newAcc;
  }

  updateAccount(id, updates, userId = null) {
    const idx = this.accounts.findIndex(a => a.id === id && (!userId || a.ownerId === userId));
    if (idx === -1) return null;

    this.accounts[idx] = {
      ...this.accounts[idx],
      ...updates,
      updatedAt: new Date().toISOString()
    };

    try {
      const mongoDb = require('./mongoDb');
      mongoDb.saveAccount(this.accounts[idx]).catch(() => {});
    } catch (_) {}
    this.saveJSON(config.accountsFile, this.accounts);
    return this.accounts[idx];
  }

  removeAccount(id, userId = null) {
    const idx = this.accounts.findIndex(a => a.id === id && (!userId || a.ownerId === userId));
    if (idx === -1) return false;

    this.accounts.splice(idx, 1);
    this.saveJSON(config.accountsFile, this.accounts);
    try {
      const mongoDb = require('./mongoDb');
      mongoDb.deleteAccount(id, userId).catch(() => {});
    } catch (_) {}
    return true;
  }

  // --- Settings methods ---
  getSettings() {
    return this.settings;
  }

  updateSettings(updates) {
    this.settings = {
      ...this.settings,
      ...updates
    };
    this.saveJSON(config.settingsFile, this.settings);
    return this.settings;
  }

  restoreAccounts(importedAccounts) {
    if (!Array.isArray(importedAccounts)) return 0;
    let count = 0;
    for (const a of importedAccounts) {
      if (!a || !a.token) continue;
      const cleanToken = a.token.trim().replace(/^"|"$/g, '');
      const existing = this.accounts.find(x => x.id === a.id || (x.token === cleanToken && x.ownerId === a.ownerId));
      if (!existing) {
        this.accounts.push({
          id: a.id || `acc_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`,
          token: cleanToken,
          label: a.label || 'Restored Bot',
          autoStart: a.autoStart !== false,
          status: 'offline',
          activity: a.activity || { type: 'PLAYING', name: '24/7 Voice' },
          voice247: a.voice247 || { enabled: false },
          lastKnownUser: a.lastKnownUser || null,
          createdAt: a.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ownerId: a.ownerId || 'default',
          ownerUsername: a.ownerUsername || ''
        });
        count++;
      }
    }
    if (count > 0) {
      this.saveJSON(config.accountsFile, this.accounts);
      logger.success('DB', `Restored ${count} bot account(s) into database.`);
    }
    return count;
  }

  // --- Uploaded MP3 Songs methods ---
  getUploadedSongs(userId = null) {
    if (!this.uploadedSongs) {
      this.uploadedSongs = this.loadJSON(config.uploadsFile, []);
    }
    if (!userId) return this.uploadedSongs;
    return this.uploadedSongs.filter(s => s.ownerId === userId);
  }

  saveUploadedSong(song) {
    if (!this.uploadedSongs) {
      this.uploadedSongs = this.loadJSON(config.uploadsFile, []);
    }
    this.uploadedSongs.unshift(song);
    this.saveJSON(config.uploadsFile, this.uploadedSongs, false);
    return song;
  }

  deleteUploadedSong(id, userId = null) {
    if (!this.uploadedSongs) {
      this.uploadedSongs = this.loadJSON(config.uploadsFile, []);
    }
    const idx = this.uploadedSongs.findIndex(s => s.id === id && (!userId || s.ownerId === userId));
    if (idx !== -1) {
      const removed = this.uploadedSongs.splice(idx, 1)[0];
      this.saveJSON(config.uploadsFile, this.uploadedSongs, false);
      return removed;
    }
    return null;
  }
}

module.exports = new Database();
