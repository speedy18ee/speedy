const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

class Database {
  constructor() {
    this.ensureDirs();
    this.accounts = this.loadJSON(config.accountsFile, []);
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

  saveJSON(filePath, data) {
    try {
      this.ensureDirs();
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
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

    this.saveJSON(config.accountsFile, this.accounts);
    return this.accounts[idx];
  }

  removeAccount(id, userId = null) {
    const idx = this.accounts.findIndex(a => a.id === id && (!userId || a.ownerId === userId));
    if (idx === -1) return false;

    this.accounts.splice(idx, 1);
    this.saveJSON(config.accountsFile, this.accounts);
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
}

module.exports = new Database();
