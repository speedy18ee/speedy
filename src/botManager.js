// Ensure discord.js-selfbot-v13 user settings bug is patched
require("./patch");

const { Client } = require("discord.js-selfbot-v13");
const EventEmitter = require("events");
const database = require("./database");
const logger = require("./logger");

class BotManager extends EventEmitter {
  constructor(lavalinkClient) {
    super();
    this.lavalink = lavalinkClient;
    // Map<accountId, { client, status, voiceState, reconnectTimeout, rawVoiceData }>
    this.bots = new Map();
  }

  // --- Start an Account ---
  async startAccount(accountId) {
    const acc = database.getAccount(accountId);
    if (!acc) throw new Error("Account not found");

    if (this.bots.has(accountId) && this.bots.get(accountId).status === "online") {
      logger.warn("BOT", `Account ${acc.label} (${accountId}) is already running.`);
      return;
    }

    logger.info("BOT", `Starting selfbot account: ${acc.label}...`);

    const client = new Client({
      checkUpdate: false,
      restRequestTimeout: 15000,
      ws: {
        properties: {
          $os: "Windows",
          $browser: "Discord Client",
          $device: "Desktop"
        }
      }
    });

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
          userId: client.user.id
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

    client.on("error", (err) => {
      logger.error("BOT", `[${acc.label}] Error: ${err.message}`);
    });

    client.on("disconnect", () => {
      botEntry.status = "offline";
      logger.warn("BOT", `[${acc.label}] Disconnected from Discord`);
      this.emit("botStatus", { accountId, status: "offline" });
    });

    // Login with account token
    try {
      await client.login(acc.token);
    } catch (err) {
      botEntry.status = "error";
      logger.error("BOT", `[${acc.label}] Failed to login: ${err.message}`);
      this.emit("botStatus", { accountId, status: "error", error: err.message });
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
        try {
          await this.startAccount(acc.id);
        } catch (err) {
          logger.error("BOT", `Failed to start account ${acc.label}: ${err.message}`);
        }
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
      channelId: channel.id
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
      await this.lavalink.destroyPlayer(guildId);
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
