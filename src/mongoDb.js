const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

class MongoDatabase {
  constructor() {
    this.client = null;
    this.db = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectTimer = null;
    this.uri = this.resolveUri();
  }

  resolveUri() {
    // 1. Check environment variable
    if (process.env.MONGODB_URI) {
      return process.env.MONGODB_URI;
    }
    // 2. Check local atlas-credentials.env file
    const atlasEnvPath = 'c:\\Users\\pradyumna\\Downloads\\atlas-credentials.env';
    try {
      if (fs.existsSync(atlasEnvPath)) {
        const content = fs.readFileSync(atlasEnvPath, 'utf8');
        const match = content.match(/MONGODB_URI=["']?([^"'\r\n]+)["']?/);
        if (match && match[1]) {
          let u = match[1].trim();
          if (!u.includes('/exc_selfbot')) {
            u = u.replace(/\.net\/?/, '.net/exc_selfbot?retryWrites=true&w=majority');
          }
          return u;
        }
      }
    } catch (_) {}

    // 3. Fallback default URI
    return 'mongodb+srv://somulapradyumna_db_user:TTKilfDxs6jQ4ax1@cluster0.m1auv30.mongodb.net/exc_selfbot?retryWrites=true&w=majority';
  }

  async connect() {
    if (this.isConnected || this.isConnecting) return;
    this.isConnecting = true;

    try {
      logger.info('MONGODB', 'Connecting to MongoDB Atlas Cloud Database...');
      this.client = new MongoClient(this.uri, {
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 10000,
        maxPoolSize: 10,
        minPoolSize: 1
      });

      await this.client.connect();
      this.db = this.client.db('exc_selfbot');
      this.isConnected = true;
      this.isConnecting = false;
      logger.success('MONGODB', 'Connected to MongoDB Atlas! Cloud persistence ACTIVE.');

      // Initialize collections and indexes
      await this.initCollections();

      // Perform initial bidirectional sync
      await this.syncFromCloud();
      await this.syncToCloud();

      // Listen for connection close
      this.client.on('close', () => {
        logger.warn('MONGODB', 'MongoDB Atlas connection closed. Scheduling reconnect...');
        this.isConnected = false;
        this.scheduleReconnect();
      });
    } catch (err) {
      this.isConnected = false;
      this.isConnecting = false;
      logger.warn('MONGODB', `Atlas connection notice: ${err.message}. (Local cache active. Will retry in 15s)`);
      this.scheduleReconnect(15000);
    }
  }

  scheduleReconnect(delay = 15000) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }

  async initCollections() {
    if (!this.db) return;
    try {
      const accountsCol = this.db.collection('accounts');
      await accountsCol.createIndex({ id: 1 }, { unique: true });
      await accountsCol.createIndex({ ownerId: 1 });
      await accountsCol.createIndex({ token: 1 });

      const usersCol = this.db.collection('users');
      await usersCol.createIndex({ username: 1 }, { unique: true });
    } catch (e) {
      logger.warn('MONGODB', `Index creation notice: ${e.message}`);
    }
  }

  // Sync all accounts from MongoDB Atlas into local memory & disk
  async syncFromCloud(userId = null) {
    if (!this.isConnected || !this.db) return 0;
    try {
      const accountsCol = this.db.collection('accounts');
      const query = userId ? { ownerId: userId } : {};
      const cloudAccounts = await accountsCol.find(query).toArray();

      if (!cloudAccounts || cloudAccounts.length === 0) return 0;

      const database = require('./database');
      let restoredCount = 0;

      for (const ca of cloudAccounts) {
        if (!ca || !ca.token) continue;
        const cleanToken = ca.token.trim().replace(/^"|"$/g, '');
        const existing = database.accounts.find(a => a.id === ca.id || (a.token === cleanToken && a.ownerId === ca.ownerId));

        if (!existing) {
          database.accounts.push({
            id: ca.id,
            ownerId: ca.ownerId || 'default',
            ownerUsername: ca.ownerUsername || '',
            token: cleanToken,
            label: ca.label || 'Saved Bot',
            autoStart: ca.autoStart !== false,
            status: 'offline',
            activity: ca.activity || { type: 'PLAYING', name: '24/7 Voice' },
            voice247: ca.voice247 || { enabled: false },
            lastKnownUser: ca.lastKnownUser || null,
            createdAt: ca.createdAt || new Date().toISOString(),
            updatedAt: ca.updatedAt || new Date().toISOString()
          });
          restoredCount++;
        } else {
          // Keep persistent cloud properties updated
          if (ca.voice247 && !existing.voice247?.guildId) existing.voice247 = ca.voice247;
          if (ca.ownerId) existing.ownerId = ca.ownerId;
          if (ca.ownerUsername) existing.ownerUsername = ca.ownerUsername;
        }
      }

      if (restoredCount > 0) {
        database.saveJSON(config.accountsFile, database.accounts, false);
        logger.success('MONGODB', `Restored ${restoredCount} account(s) from MongoDB Atlas cloud!`);
        try {
          if (global.botManager && typeof global.botManager.startAll === 'function') {
            global.botManager.startAll(userId).catch(() => {});
          }
        } catch (_) {}
      }
      return restoredCount;
    } catch (err) {
      logger.error('MONGODB', `Error syncing from cloud: ${err.message}`);
      return 0;
    }
  }

  // Push all local accounts to MongoDB Atlas to ensure nothing is lost
  async syncToCloud() {
    if (!this.isConnected || !this.db) return 0;
    try {
      const database = require('./database');
      const accountsCol = this.db.collection('accounts');
      let saved = 0;

      for (const a of database.accounts) {
        if (!a || !a.token) continue;
        const doc = {
          id: a.id,
          ownerId: a.ownerId || 'default',
          ownerUsername: a.ownerUsername || '',
          token: a.token,
          label: a.label || 'Selfbot Account',
          autoStart: a.autoStart !== false,
          status: a.status || 'offline',
          activity: a.activity || { type: 'PLAYING', name: '24/7 Voice' },
          voice247: a.voice247 || { enabled: false },
          lastKnownUser: a.lastKnownUser || null,
          createdAt: a.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        await accountsCol.updateOne(
          { id: a.id },
          { $set: doc },
          { upsert: true }
        );
        saved++;
      }

      if (saved > 0) {
        logger.info('MONGODB', `Synchronized ${saved} account(s) to MongoDB Atlas.`);
      }
      return saved;
    } catch (err) {
      logger.error('MONGODB', `Error syncing to cloud: ${err.message}`);
      return 0;
    }
  }

  // Save or update a single account immediately
  async saveAccount(account) {
    if (!this.isConnected || !this.db || !account) return false;
    try {
      const accountsCol = this.db.collection('accounts');
      await accountsCol.updateOne(
        { id: account.id },
        { $set: { ...account, updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
      return true;
    } catch (err) {
      logger.error('MONGODB', `Error saving account ${account.id}: ${err.message}`);
      return false;
    }
  }

  // Save multiple accounts (for mass token importer)
  async saveAccountsBatch(accountsList) {
    if (!this.isConnected || !this.db || !Array.isArray(accountsList)) return 0;
    try {
      const accountsCol = this.db.collection('accounts');
      let count = 0;
      for (const a of accountsList) {
        if (!a || !a.token) continue;
        await accountsCol.updateOne(
          { id: a.id },
          { $set: { ...a, updatedAt: new Date().toISOString() } },
          { upsert: true }
        );
        count++;
      }
      return count;
    } catch (err) {
      logger.error('MONGODB', `Error saving batch accounts: ${err.message}`);
      return 0;
    }
  }

  // Delete account from MongoDB Atlas
  async deleteAccount(id, userId = null) {
    if (!this.isConnected || !this.db) return false;
    try {
      const accountsCol = this.db.collection('accounts');
      const query = { id };
      if (userId) query.ownerId = userId;
      const res = await accountsCol.deleteOne(query);
      return res.deletedCount > 0;
    } catch (err) {
      logger.error('MONGODB', `Error deleting account ${id}: ${err.message}`);
      return false;
    }
  }

  // Sync users with MongoDB Atlas
  async saveUser(user) {
    if (!this.isConnected || !this.db || !user) return false;
    try {
      const usersCol = this.db.collection('users');
      await usersCol.updateOne(
        { username: user.username },
        { $set: { ...user, updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
      return true;
    } catch (err) {
      logger.error('MONGODB', `Error saving user ${user.username}: ${err.message}`);
      return false;
    }
  }

  async syncUsersFromCloud() {
    if (!this.isConnected || !this.db) return 0;
    try {
      const usersCol = this.db.collection('users');
      const cloudUsers = await usersCol.find({}).toArray();
      if (!cloudUsers || cloudUsers.length === 0) return 0;

      const authManager = require('./authManager');
      let count = 0;
      for (const u of cloudUsers) {
        if (!u || !u.username) continue;
        const existing = authManager.users.find(x => x.username.toLowerCase() === u.username.toLowerCase());
        if (!existing) {
          authManager.users.push(u);
          count++;
        } else {
          if (u.password) existing.password = u.password;
          if (u.hwid && !existing.hwid) existing.hwid = u.hwid;
          if (typeof u.botLimit === 'number') existing.botLimit = u.botLimit;
        }
      }
      if (count > 0) {
        authManager.saveUsers(false);
        logger.success('MONGODB', `Restored ${count} user(s) from MongoDB Atlas!`);
      }
      return count;
    } catch (err) {
      logger.error('MONGODB', `Error syncing users from cloud: ${err.message}`);
      return 0;
    }
  }

  getStatus() {
    return {
      connected: this.isConnected,
      connecting: this.isConnecting,
      provider: 'MongoDB Atlas Cloud',
      database: 'exc_selfbot'
    };
  }
}

module.exports = new MongoDatabase();
