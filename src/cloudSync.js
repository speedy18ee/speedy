const logger = require('./logger');

class CloudSync {
  constructor() {
    this.apiKey = process.env.RENDER_API_KEY || 'rnd_TYXkNgNIAqGZH2SeJLnll09A7roP';
    this.serviceId = process.env.RENDER_SERVICE_ID || 'srv-dbe718bncjis73d7slqg';
    this.syncTimeout = null;
    this.isSyncing = false;
    this.lastSync = null;
  }

  isAvailable() {
    return Boolean(this.apiKey && this.serviceId);
  }

  scheduleSync(delayMs = 4000) {
    if (!this.isAvailable()) return;
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      this.syncNow().catch(err => {
        logger.error('CLOUD', `Cloud sync failed: ${err.message}`);
      });
    }, delayMs);
  }

  async syncNow() {
    if (!this.isAvailable()) {
      return { success: false, reason: 'Render API credentials not configured' };
    }
    if (this.isSyncing) {
      return { success: false, reason: 'Sync already in progress' };
    }

    this.isSyncing = true;
    try {
      const authManager = require('./authManager');
      const database = require('./database');

      const usersData = JSON.stringify(authManager.users || []);
      const accountsData = JSON.stringify(database.accounts || []);

      // 1. Fetch current env vars to preserve existing variables
      const res = await fetch(`https://api.render.com/v1/services/${this.serviceId}/env-vars`, {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch current env-vars from Render: HTTP ${res.status}`);
      }

      const currentVars = await res.json();
      const varMap = new Map();
      if (Array.isArray(currentVars)) {
        for (const item of currentVars) {
          if (item.envVar && item.envVar.key) {
            varMap.set(item.envVar.key, item.envVar.value);
          }
        }
      }

      // 2. Set persistent variables
      varMap.set('PERSISTENT_USERS', usersData);
      varMap.set('PERSISTENT_ACCOUNTS', accountsData);
      varMap.set('RENDER_API_KEY', this.apiKey);
      varMap.set('RENDER_SERVICE_ID', this.serviceId);

      const payload = [];
      for (const [key, value] of varMap.entries()) {
        payload.push({ key, value });
      }

      // 3. Update Render environment variables
      const updateRes = await fetch(`https://api.render.com/v1/services/${this.serviceId}/env-vars`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (!updateRes.ok) {
        throw new Error(`Failed to update env-vars on Render: HTTP ${updateRes.status}`);
      }

      this.lastSync = new Date().toISOString();
      logger.success('CLOUD', `Cloud Persistence Synced: Saved ${authManager.users.length} user(s) and ${database.accounts.length} bot(s) to Render permanently.`);
      return {
        success: true,
        usersCount: authManager.users.length,
        accountsCount: database.accounts.length,
        lastSync: this.lastSync
      };
    } catch (err) {
      logger.error('CLOUD', `Sync to Render error: ${err.message}`);
      throw err;
    } finally {
      this.isSyncing = false;
    }
  }
}

module.exports = new CloudSync();
