// Ensure discord.js-selfbot-v13 user settings bug is patched
require("./patch");

const { Client } = require("discord.js-selfbot-v13");
const EventEmitter = require("events");
const database = require("./database");
const logger = require("./logger");
const config = require("./config");

// Verified fast & working proxy pool for multi-bot Discord Gateway connections (Webshare 10 Proxies)
const WORKING_PROXIES = [
  'http://nzpqvgqf:9e8j1sjfnbyh@198.23.243.226:6361',
  'http://nzpqvgqf:9e8j1sjfnbyh@84.247.60.125:6095',
  'http://nzpqvgqf:9e8j1sjfnbyh@191.96.254.138:6185',
  'http://nzpqvgqf:9e8j1sjfnbyh@104.164.49.38:7693',
  'http://nzpqvgqf:9e8j1sjfnbyh@23.26.71.145:5628',
  'http://nzpqvgqf:9e8j1sjfnbyh@198.46.161.42:5092',
  'http://nzpqvgqf:9e8j1sjfnbyh@64.137.10.153:5803',
  'http://nzpqvgqf:9e8j1sjfnbyh@38.154.185.97:6370',
  'http://nzpqvgqf:9e8j1sjfnbyh@64.137.96.74:6641',
  'http://nzpqvgqf:9e8j1sjfnbyh@45.38.107.97:6014'
];

class BotManager extends EventEmitter {
  constructor(lavalinkClient) {
    super();
    this.lavalink = lavalinkClient;
    // Map<accountId, { client, status, voiceState, reconnectTimeout, rawVoiceData }>
    this.bots = new Map();
  }

  // --- Start an Account with Multi-Proxy Pool & Failover ---
  async startAccount(accountId) {
    const acc = database.getAccount(accountId);
    if (!acc) throw new Error("Account not found");

    if (this.bots.has(accountId) && this.bots.get(accountId).status === "online") {
      logger.warn("BOT", `Account ${acc.label} (${accountId}) is already running.`);
      return;
    }

    const settings = database.getSettings();
    const isOldDeadProxy = (p) => p && p.includes('pldkrffl');
    const candidateProxies = [];

    if (acc.proxy && acc.proxy.trim() && !isOldDeadProxy(acc.proxy)) {
      candidateProxies.push(acc.proxy.trim());
    }
    if (settings.proxy && settings.proxy.trim() && !candidateProxies.includes(settings.proxy.trim()) && !isOldDeadProxy(settings.proxy)) {
      candidateProxies.push(settings.proxy.trim());
    }
    if (process.env.DISCORD_PROXY && process.env.DISCORD_PROXY.trim() && !candidateProxies.includes(process.env.DISCORD_PROXY.trim()) && !isOldDeadProxy(process.env.DISCORD_PROXY)) {
      candidateProxies.push(process.env.DISCORD_PROXY.trim());
    }

    // Rotate 10 Webshare proxies so each bot gets its own unique primary IP address
    let hash = 0;
    for (let c = 0; c < accountId.length; c++) hash = (hash + accountId.charCodeAt(c)) % WORKING_PROXIES.length;
    const rotatedPool = [
      ...WORKING_PROXIES.slice(hash),
      ...WORKING_PROXIES.slice(0, hash)
    ];

    for (const p of rotatedPool) {
      if (!candidateProxies.includes(p)) candidateProxies.push(p);
    }
    if (candidateProxies.length === 0) candidateProxies.push(null);

    let lastError = null;

    for (let i = 0; i < candidateProxies.length; i++) {
      const proxy = candidateProxies[i];
      const maskedProxy = proxy ? proxy.replace(/:[^:]*@/, ':****@') : 'Direct';
      logger.info("BOT", `Starting selfbot account: ${acc.label} (Attempt ${i + 1}/${candidateProxies.length}) via ${maskedProxy}...`);

      try {
        await this._startWithProxy(accountId, acc, proxy);
        return; // Success!
      } catch (err) {
        lastError = err;
        logger.warn("BOT", `[${acc.label}] Attempt ${i + 1} failed: ${err.message}`);

        // If Discord says token is invalid (4004 / TOKEN_INVALID), do not waste time retrying proxies
        if (err.message && (err.message.includes("TOKEN_INVALID") || err.message.includes("An invalid token was provided") || err.message.includes("4004"))) {
          break;
        }

        if (i < candidateProxies.length - 1) {
          await new Promise(r => setTimeout(r, 1200));
        }
      }
    }

    const botEntry = this.bots.get(accountId) || { accountId, account: acc };
    botEntry.status = "error";
    botEntry.error = lastError?.message || "Connection failed";
    this.bots.set(accountId, botEntry);
    this.emit("botStatus", { accountId, status: "error", error: botEntry.error });
    throw lastError || new Error("Failed to connect with available proxies");
  }

  async _startWithProxy(accountId, acc, proxy) {
    const clientOptions = {
      checkUpdate: false,
      restRequestTimeout: 40000,
      syncStatus: false
    };

    if (proxy && typeof proxy === 'string' && proxy.trim()) {
      let formattedProxy = proxy.trim();
      if (!formattedProxy.startsWith('http://') && !formattedProxy.startsWith('https://') && !formattedProxy.startsWith('socks5://') && !formattedProxy.startsWith('socks4://')) {
        formattedProxy = `socks5://${formattedProxy}`;
      }
      clientOptions.proxy = formattedProxy;
    }

    const client = new Client(clientOptions);

    // Guard against Discord API sending null friend_source_flags or other settings
    if (client.settings && client.settings._patch) {
      const origPatch = client.settings._patch;
      client.settings._patch = function(data) {
        if (data && typeof data === 'object') {
          if (!data.friend_source_flags) {
            data.friend_source_flags = { all: false, mutual_friends: false, mutual_guilds: false };
          }
        }
        try {
          return origPatch.call(this, data);
        } catch (e) {
          return this;
        }
      };
    }

    const botEntry = {
      accountId,
      account: acc,
      client,
      status: "connecting",
      ping: 0,
      currentVoice: null,
      reconnectTimeout: null,
      rawVoiceData: {
        sessionId: null,
        token: null,
        endpoint: null
      }
    };

    this.bots.set(accountId, botEntry);
    this.emit("botStatus", { accountId, status: "connecting" });

    // --- Setup Listeners ---
    client.on("ready", async () => {
      botEntry.status = "online";
      botEntry.error = null;
      botEntry.ping = client.ws.ping;
      logger.success("BOT", `Account connected: ${client.user.tag} (ID: ${client.user.id})`);

      // Open dedicated Lavalink audio session for this bot account
      this.lavalink.registerBotSession(client.user.id);

      // Save user details
      const userMeta = {
        id: client.user.id,
        tag: client.user.tag,
        username: client.user.username,
        avatar: client.user.displayAvatarURL({ dynamic: true, format: "png", size: 128 })
      };
      database.updateAccount(accountId, { lastKnownUser: userMeta });

      // Apply initial status & activity
      this.applyPresence(client, acc);

      // Check 24/7 Voice Auto-Join
      if (acc.voice247 && acc.voice247.enabled && acc.voice247.channelId) {
        logger.voice("24/7", `Auto-rejoining 24/7 voice channel for ${acc.label}...`);
        setTimeout(() => {
          this.joinVoice(accountId, acc.voice247.channelId, {
            guildId: acc.voice247.guildId,
            selfMute: acc.voice247.selfMute,
            selfDeaf: acc.voice247.selfDeaf
          });
        }, 2000);
      }

      this.emit("botStatus", { accountId, status: "online", user: userMeta, ping: client.ws.ping });
    });

    // Capture raw gateway events for Lavalink v4 voice handshake
    const tryDispatchLavalinkVoice = async (guildId) => {
      const { token, endpoint, sessionId, channelId } = botEntry.rawVoiceData;
      if (token && endpoint && sessionId && channelId && client.user) {
        logger.voice("VOICE", `Dispatching complete voice handshake for guild ${guildId} to Lavalink...`);
        await this.lavalink.updateVoice(guildId, {
          token,
          endpoint,
          sessionId,
          channelId,
          userId: client.user.id,
          accountId: botEntry.accountId,
          ownerId: botEntry.account?.ownerId || null
        });
      }
    };

    client.on("raw", async (packet) => {
      if (!packet.t || !packet.d) return;

      if (packet.t === "VOICE_SERVER_UPDATE") {
        const { token, endpoint, guild_id } = packet.d;
        botEntry.rawVoiceData.token = token;
        botEntry.rawVoiceData.endpoint = endpoint;
        botEntry.rawVoiceData.guildId = guild_id;

        if (!botEntry.rawVoiceData.channelId && botEntry.currentVoice?.channelId) {
          botEntry.rawVoiceData.channelId = botEntry.currentVoice.channelId;
        }

        await tryDispatchLavalinkVoice(guild_id);
      }

      if (packet.t === "VOICE_STATE_UPDATE") {
        const { session_id, user_id, channel_id, guild_id } = packet.d;
        if (client.user && user_id === client.user.id) {
          botEntry.rawVoiceData.sessionId = session_id;
          
          if (channel_id) {
            botEntry.rawVoiceData.channelId = channel_id;
            botEntry.currentVoice = {
              guildId: guild_id,
              channelId: channel_id
            };
            
            await tryDispatchLavalinkVoice(guild_id);
          } else {
            // Disconnected from voice
            botEntry.currentVoice = null;
            botEntry.rawVoiceData.token = null;
            botEntry.rawVoiceData.endpoint = null;
            botEntry.rawVoiceData.channelId = null;

            // Handle 24/7 keep-alive reconnection if enabled
            const currentAcc = database.getAccount(accountId);
            if (currentAcc && currentAcc.voice247 && currentAcc.voice247.enabled && currentAcc.voice247.channelId) {
              logger.warn("24/7", `Account ${currentAcc.label} disconnected from voice! Scheduling 24/7 reconnect in 5s...`);
              if (botEntry.reconnectTimeout) clearTimeout(botEntry.reconnectTimeout);
              botEntry.reconnectTimeout = setTimeout(() => {
                this.joinVoice(accountId, currentAcc.voice247.channelId, {
                  guildId: currentAcc.voice247.guildId,
                  selfMute: currentAcc.voice247.selfMute,
                  selfDeaf: currentAcc.voice247.selfDeaf
                });
              }, 5000);
            }
          }

          this.emit("botVoice", { accountId, currentVoice: botEntry.currentVoice });
        }
      }
    });

    client.on("debug", (info) => {
      if (typeof info === 'string' && (info.includes("WS") || info.includes("Gateway") || info.includes("Session") || info.includes("Connecting") || info.includes("Handshake") || info.includes("4004") || info.includes("4000"))) {
        logger.info("BOT_DEBUG", `[${acc.label}] ${info}`);
      }
    });

    client.on("shardError", (err) => {
      logger.error("BOT", `[${acc.label}] Shard Error: ${err.message}`);
      botEntry.status = "error";
      botEntry.error = err.message;
      this.emit("botStatus", { accountId, status: "error", error: err.message });
    });

    client.on("shardDisconnect", (event) => {
      const code = event?.code || "unknown";
      const reason = event?.reason || "none";
      logger.warn("BOT", `[${acc.label}] Shard Disconnected (code: ${code}, reason: ${reason})`);
      botEntry.status = "offline";
      this.emit("botStatus", { accountId, status: "offline", error: `Code ${code}` });
    });

    client.on("invalidated", () => {
      logger.error("BOT", `[${acc.label}] Token invalidated by Discord`);
      botEntry.status = "error";
      botEntry.error = "Token invalidated";
      this.emit("botStatus", { accountId, status: "error", error: "Token invalidated" });
    });

    client.on("error", (err) => {
      logger.error("BOT", `[${acc.label}] Error: ${err.message}`);
    });

    client.on("disconnect", () => {
      botEntry.status = "offline";
      logger.warn("BOT", `[${acc.label}] Disconnected from Discord`);
      this.emit("botStatus", { accountId, status: "offline" });
    });

    // Clean and validate token
    const cleanToken = (acc.token || '').trim().replace(/^["']|["']$/g, '');
    if (!cleanToken) {
      throw new Error("Token is empty or invalid format");
    }

    // Login with account token with 20s timeout
    try {
      await Promise.race([
        client.login(cleanToken),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timed out after 20s (retrying with next proxy...)")), 20000))
      ]);
    } catch (err) {
      try { client.destroy(); } catch (_) {}
      throw err;
    }
  }

  // --- Stop an Account ---
  async stopAccount(accountId) {
    const botEntry = this.bots.get(accountId);
    if (!botEntry) return;

    if (botEntry.reconnectTimeout) {
      clearTimeout(botEntry.reconnectTimeout);
      botEntry.reconnectTimeout = null;
    }

    try {
      // Leave voice if in one
      if (botEntry.currentVoice?.guildId) {
        await this.leaveVoice(accountId);
      }
      botEntry.client.destroy();
    } catch (e) {}

    botEntry.status = "offline";
    botEntry.currentVoice = null;
    this.bots.delete(accountId);

    logger.info("BOT", `Account ${botEntry.account.label} stopped.`);
    this.emit("botStatus", { accountId, status: "offline" });
  }

  // --- Start All Accounts ---
  async startAll(userId = null) {
    const accounts = database.getAccounts(userId);
    logger.info("BOT", `Starting ${accounts.length} account(s)${userId ? ` for user ${userId}` : ''}...`);
    for (const acc of accounts) {
      if (acc.autoStart !== false) {
        this.startAccount(acc.id).catch(err => {
          logger.error("BOT", `Failed to start account ${acc.label}: ${err.message}`);
        });
        // 1-second stagger between bot launches for smooth connection
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  // --- Stop All Accounts ---
  async stopAll(userId = null) {
    const accounts = database.getAccounts(userId);
    logger.info("BOT", `Stopping ${accounts.length} account(s)...`);
    for (const acc of accounts) {
      if (this.bots.has(acc.id)) {
        await this.stopAccount(acc.id);
      }
    }
  }

  // --- Join Voice Channel ---
  async joinVoice(accountId, channelId, options = {}) {
    const botEntry = this.bots.get(accountId);
    if (!botEntry || !botEntry.client || botEntry.status !== "online") {
      throw new Error("Bot is not online");
    }

    const client = botEntry.client;
    
    // Find channel in cache or fetch
    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch (err) {
      throw new Error(`Failed to fetch voice channel: ${err.message}`);
    }

    if (!channel || !channel.isVoice()) {
      throw new Error("Specified channel is not a valid voice channel");
    }

    const guildId = channel.guild.id;
    const selfMute = options.selfMute ?? false;
    const selfDeaf = options.selfDeaf ?? false;

    logger.voice("VOICE", `Account [${botEntry.account.label}] joining "${channel.name}" in "${channel.guild.name}"...`);

    // Broadcast op 4 to Discord Gateway
    const shard = client.ws.shards.first();
    if (!shard) {
      throw new Error("No active gateway shard available");
    }

    shard.send({
      op: 4,
      d: {
        guild_id: guildId,
        channel_id: channel.id,
        self_mute: selfMute,
        self_deaf: selfDeaf,
        self_video: false
      }
    });

    botEntry.currentVoice = {
      guildId,
      guildName: channel.guild.name,
      channelId: channel.id,
      channelName: channel.name,
      selfMute,
      selfDeaf
    };

    // Update Lavalink player association if player exists or created
    botEntry.rawVoiceData.channelId = channel.id;
    this.lavalink.createPlayer(guildId, {
      accountId,
      userId: client.user.id,
      channelId: channel.id,
      ownerId: botEntry.account?.ownerId || null
    });

    this.emit("botVoice", { accountId, currentVoice: botEntry.currentVoice });
    return botEntry.currentVoice;
  }

  // --- Leave Voice Channel ---
  async leaveVoice(accountId) {
    const botEntry = this.bots.get(accountId);
    if (!botEntry || !botEntry.client) return;

    if (botEntry.reconnectTimeout) {
      clearTimeout(botEntry.reconnectTimeout);
      botEntry.reconnectTimeout = null;
    }

    const guildId = botEntry.currentVoice?.guildId;
    if (guildId) {
      const shard = botEntry.client.ws.shards.first();
      if (shard) {
        shard.send({
          op: 4,
          d: {
            guild_id: guildId,
            channel_id: null,
            self_mute: false,
            self_deaf: false
          }
        });
      }

      // Destroy Lavalink player
      await this.lavalink.destroyPlayer(guildId, accountId, botEntry.account?.ownerId);
    }

    botEntry.currentVoice = null;
    logger.voice("VOICE", `Account [${botEntry.account.label}] left voice channel.`);
    this.emit("botVoice", { accountId, currentVoice: null });
  }

  // --- Configure 24/7 Stay ---
  async set247(accountId, { enabled, guildId, channelId, selfMute = false, selfDeaf = false }) {
    const acc = database.getAccount(accountId);
    if (!acc) throw new Error("Account not found");

    let guildName = "";
    let channelName = "";

    const botEntry = this.bots.get(accountId);
    if (botEntry && botEntry.client && channelId) {
      try {
        const ch = await botEntry.client.channels.fetch(channelId);
        if (ch) {
          channelName = ch.name;
          guildName = ch.guild.name;
        }
      } catch (e) {}
    }

    const voice247Config = {
      enabled: !!enabled,
      guildId: guildId || "",
      guildName,
      channelId: channelId || "",
      channelName,
      selfMute: !!selfMute,
      selfDeaf: !!selfDeaf
    };

    database.updateAccount(accountId, { voice247: voice247Config });
    logger.voice("24/7", `Updated 24/7 config for ${acc.label}: ${enabled ? "ACTIVE on " + (channelName || channelId) : "DISABLED"}`);

    if (enabled && channelId && botEntry && botEntry.status === "online") {
      await this.joinVoice(accountId, channelId, { guildId, selfMute, selfDeaf });
    } else if (!enabled && botEntry && botEntry.currentVoice) {
      await this.leaveVoice(accountId);
    }

    return voice247Config;
  }

  // --- Mass Voice: Join ALL Accounts to a Voice Channel & Enable 24/7 ---
  async joinAllToVoice(userId = null, channelId, { guildId = null, keep247 = true, selfMute = false, selfDeaf = false } = {}) {
    if (!channelId) throw new Error("Voice Channel ID is required");

    const accounts = database.getAccounts(userId);
    if (!accounts || accounts.length === 0) throw new Error("No Discord accounts found in your dashboard.");

    let detectedGuildId = guildId;
    let channelName = "";
    let guildName = "";

    // Resolve channel & guild info from any online bot
    for (const [id, botEntry] of this.bots) {
      if (botEntry.client && botEntry.status === "online") {
        try {
          const ch = await botEntry.client.channels.fetch(channelId);
          if (ch) {
            channelName = ch.name;
            guildName = ch.guild.name;
            detectedGuildId = ch.guild.id;
            break;
          }
        } catch (e) {}
      }
    }

    let joinedCount = 0;
    const errors = [];

    for (const acc of accounts) {
      // 1. Update 24/7 setting in database
      const voice247Config = {
        enabled: !!keep247,
        guildId: detectedGuildId || "",
        guildName: guildName || "",
        channelId: channelId,
        channelName: channelName || "",
        selfMute: !!selfMute,
        selfDeaf: !!selfDeaf
      };
      database.updateAccount(acc.id, { voice247: voice247Config });

      // 2. If bot is online, join the channel
      const botEntry = this.bots.get(acc.id);
      if (botEntry && botEntry.status === "online") {
        try {
          await this.joinVoice(acc.id, channelId, {
            guildId: detectedGuildId,
            selfMute,
            selfDeaf
          });
          joinedCount++;
        } catch (err) {
          errors.push(`${acc.label}: ${err.message}`);
        }
      }
    }

    logger.voice("24/7", `Mass voice join executed: ${joinedCount}/${accounts.length} bots joined ${channelName || channelId} (24/7: ${keep247 ? 'ACTIVE' : 'OFF'})`);
    this.emit("accountsUpdated", { accounts: this.getAllBotsStatus(userId) });

    return {
      success: true,
      total: accounts.length,
      joined: joinedCount,
      channelName: channelName || channelId,
      guildName,
      keep247,
      errors
    };
  }

  // --- Mass Voice: Disconnect ALL Accounts from Voice ---
  async leaveAllVoice(userId = null, disable247 = true) {
    const accounts = database.getAccounts(userId);
    let leftCount = 0;

    for (const acc of accounts) {
      if (disable247) {
        database.updateAccount(acc.id, {
          voice247: {
            enabled: false,
            guildId: "",
            guildName: "",
            channelId: "",
            channelName: "",
            selfMute: false,
            selfDeaf: false
          }
        });
      }

      const botEntry = this.bots.get(acc.id);
      if (botEntry) {
        try {
          await this.leaveVoice(acc.id);
          leftCount++;
        } catch (e) {}
      }
    }

    logger.voice("24/7", `Mass voice disconnect: ${leftCount} bots left voice.`);
    this.emit("accountsUpdated", { accounts: this.getAllBotsStatus(userId) });

    return { success: true, leftCount };
  }

  // --- Apply Presence ---
  applyPresence(client, acc) {
    if (!client.user) return;

    try {
      // Set status: online, idle, dnd, invisible
      const status = acc.status || "online";
      client.user.setStatus(status);

      // Set activity if configured
      if (acc.activity && acc.activity.name) {
        client.user.setActivity(acc.activity.name, {
          type: acc.activity.type || "PLAYING",
          url: acc.activity.url || undefined
        });
      }
    } catch (err) {
      logger.warn("BOT", `Could not update presence: ${err.message}`);
    }
  }

  // --- Set Status & Activity ---
  setStatus(accountId, status, activity = null) {
    const acc = database.getAccount(accountId);
    if (!acc) throw new Error("Account not found");

    const updates = { status };
    if (activity !== null) updates.activity = activity;

    database.updateAccount(accountId, updates);

    const botEntry = this.bots.get(accountId);
    if (botEntry && botEntry.client && botEntry.status === "online") {
      this.applyPresence(botEntry.client, { ...acc, ...updates });
    }
  }

  // --- Get Guilds & Voice Channels for an Account ---
  async getGuildsAndChannels(accountId) {
    const botEntry = this.bots.get(accountId);
    if (!botEntry || !botEntry.client || botEntry.status !== "online") {
      return [];
    }

    const client = botEntry.client;
    const guildsList = [];

    for (const [, guild] of client.guilds.cache) {
      const voiceChannels = [];
      for (const [, ch] of guild.channels.cache) {
        if (ch.isVoice()) {
          voiceChannels.push({
            id: ch.id,
            name: ch.name,
            type: ch.type,
            userLimit: ch.userLimit,
            bitrate: ch.bitrate
          });
        }
      }

      guildsList.push({
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL({ dynamic: true, format: "png", size: 64 }),
        voiceChannels
      });
    }

    return guildsList;
  }

  // --- Get Status Summary for accounts (filtered by userId if provided) ---
  getAllBotsStatus(userId = null) {
    const accounts = database.getAccounts(userId);
    return accounts.map(acc => {
      const live = this.bots.get(acc.id);
      return {
        id: acc.id,
        ownerId: acc.ownerId,
        label: acc.label,
        tokenMasked: acc.token ? `${acc.token.substring(0, 12)}...${acc.token.substring(acc.token.length - 6)}` : "",
        autoStart: acc.autoStart,
        status: live ? live.status : "offline",
        error: live?.error || null,
        ping: live ? live.ping : 0,
        user: live?.client?.user ? {
          id: live.client.user.id,
          tag: live.client.user.tag,
          username: live.client.user.username,
          avatar: live.client.user.displayAvatarURL({ dynamic: true, format: "png", size: 128 })
        } : acc.lastKnownUser,
        currentVoice: live?.currentVoice || null,
        voice247: acc.voice247,
        presence: {
          status: acc.status || "online",
          activity: acc.activity || null
        }
      };
    });
  }
}

module.exports = BotManager;
