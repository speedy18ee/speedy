const EventEmitter = require('events');
const logger = require('./logger');

class LavalinkSession extends EventEmitter {
  constructor(client, userId = '100000000000000000') {
    super();
    this.client = client;
    this.userId = userId;
    this.ws = null;
    this.sessionId = null;
    this.connected = false;
    this.reconnectTimeout = null;
  }

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      return;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    try {
      logger.info('LAVALINK', `Opening session for User ${this.userId} (${this.client.wsUrl})...`);

      this.ws = new WebSocket(this.client.wsUrl, {
        headers: {
          'Authorization': this.client.auth,
          'User-Id': String(this.userId),
          'Client-Name': 'Selfbot-Dashboard/2.0'
        }
      });

      this.ws.onopen = () => {
        logger.success('LAVALINK', `WebSocket connected for User ${this.userId}`);
      };

      this.ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          this.handleMessage(payload);
        } catch (err) {
          logger.error('LAVALINK', `Parse error: ${err.message}`);
        }
      };

      this.ws.onerror = (err) => {
        logger.error('LAVALINK', `WS error [User ${this.userId}]: ${err.message || err}`);
      };

      this.ws.onclose = (event) => {
        this.connected = false;
        this.sessionId = null;
        logger.warn('LAVALINK', `Session closed for User ${this.userId} (code: ${event.code}). Retrying in 5s...`);
        this.emit('disconnect');
        this.scheduleReconnect();
      };

    } catch (err) {
      logger.error('LAVALINK', `Session connect error: ${err.message}`);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, 5000);
  }

  handleMessage(msg) {
    switch (msg.op) {
      case 'ready':
        this.sessionId = msg.sessionId;
        this.connected = true;
        logger.success('LAVALINK', `Session ready for User ${this.userId}! SessionId: ${msg.sessionId}`);
        this.emit('ready', { sessionId: this.sessionId, userId: this.userId });
        break;

      case 'stats':
        this.client.stats = {
          players: msg.players || 0,
          playingPlayers: msg.playingPlayers || 0,
          uptime: msg.uptime || 0,
          memory: msg.memory || {},
          cpu: msg.cpu || {}
        };
        this.client.emit('stats', this.client.stats);
        break;

      case 'playerUpdate':
        if (msg.guildId && this.client.players.has(msg.guildId)) {
          const player = this.client.players.get(msg.guildId);
          if (msg.state) {
            player.position = msg.state.position || 0;
            player.ping = msg.state.ping || 0;
            player.connected = msg.state.connected ?? true;
            this.client.emit('playerUpdate', player);
          }
        }
        break;

      case 'event':
        this.client.handleEvent(msg);
        break;
    }
  }

  destroy() {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }
  }
}

class LavalinkClient extends EventEmitter {
  constructor(nodeConfig) {
    super();
    this.updateConfig(nodeConfig);
    
    // Map<userId, LavalinkSession>
    this.sessions = new Map();
    // Default session for search & stats
    this.defaultSession = null;

    this.stats = {
      players: 0,
      playingPlayers: 0,
      uptime: 0,
      memory: { used: 0, free: 0, allocated: 0 },
      cpu: { cores: 0, systemLoad: 0, lavalinkLoad: 0 }
    };
    
    // Key: guildId -> Player State
    this.players = new Map();
  }

  get sessionId() {
    return this.defaultSession?.sessionId || null;
  }

  get connected() {
    return this.defaultSession?.connected || false;
  }

  updateConfig(nodeConfig) {
    this.name = nodeConfig.name || "Lava Lenin";
    this.auth = nodeConfig.auth || "ganahubkl";
    this.secure = !!nodeConfig.secure;

    let cleanUrl = (nodeConfig.url || "noi6.visihost.in:25591").trim();
    cleanUrl = cleanUrl.replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').replace(/\/.*$/, '');
    
    const parts = cleanUrl.split(':');
    this.host = parts[0] || "noi6.visihost.in";
    this.port = parts[1] ? parseInt(parts[1], 10) : (this.secure ? 443 : 80);

    this.httpUrl = `${this.secure ? 'https' : 'http'}://${this.host}:${this.port}`;
    this.wsUrl = `${this.secure ? 'wss' : 'ws'}://${this.host}:${this.port}/v4/websocket`;
  }

  connect() {
    if (!this.defaultSession) {
      this.defaultSession = new LavalinkSession(this, '100000000000000000');
      this.defaultSession.on('ready', (d) => this.emit('ready', d));
      this.defaultSession.on('disconnect', () => this.emit('disconnect'));
    }
    this.defaultSession.connect();
  }

  // Register and open a dedicated session for a Discord bot user ID
  registerBotSession(userId) {
    if (!userId) return null;
    const strId = String(userId);

    if (this.sessions.has(strId)) {
      return this.sessions.get(strId);
    }

    logger.info('LAVALINK', `Registering bot audio session for User ID: ${strId}`);
    const session = new LavalinkSession(this, strId);
    this.sessions.set(strId, session);
    session.connect();

    session.on('ready', () => {
      // Re-sync any players belonging to this bot
      this.resyncPlayersForUser(strId);
    });

    return session;
  }

  getSessionForUser(userId) {
    if (userId && this.sessions.has(String(userId))) {
      return this.sessions.get(String(userId));
    }
    // Return first ready session if available
    for (const session of this.sessions.values()) {
      if (session.sessionId && session.connected) return session;
    }
    return this.defaultSession;
  }

  handleEvent(event) {
    const { type, guildId } = event;
    const player = this.players.get(guildId);
    if (!player) return;

    logger.info('MUSIC', `Lavalink event: ${type} for guild ${guildId}`);

    switch (type) {
      case 'TrackStartEvent':
        player.playing = true;
        player.paused = false;
        this.emit('trackStart', { player, track: event.track });
        break;

      case 'TrackEndEvent':
        this.handleTrackEnd(player, event);
        break;

      case 'TrackExceptionEvent':
        logger.error('MUSIC', `Track exception: ${event.exception?.message || 'Unknown'}`);
        this.playNext(guildId);
        break;

      case 'TrackStuckEvent':
        logger.warn('MUSIC', `Track stuck at ${event.thresholdMs}ms, skipping...`);
        this.playNext(guildId);
        break;

      case 'WebSocketClosedEvent':
        logger.warn('MUSIC', `Voice channel closed (code ${event.code}): ${event.reason}`);
        break;
    }
  }

  handleTrackEnd(player, event) {
    player.playing = false;
    if (event.reason === 'replaced') return;

    if (player.loop === 'track' && player.currentTrack) {
      this.play(player.guildId, player.currentTrack, { noReplace: false });
      return;
    }

    if (player.loop === 'queue' && player.currentTrack) {
      player.queue.push(player.currentTrack);
    }

    this.playNext(player.guildId);
  }

  async playNext(guildId) {
    const player = this.players.get(guildId);
    if (!player) return;

    if (player.queue.length > 0) {
      const nextTrack = player.queue.shift();
      player.currentTrack = nextTrack;
      player.position = 0;
      const filtersPayload = this.buildFiltersPayload(player);
      await this.sendPlayerUpdate(guildId, {
        track: { encoded: nextTrack.encoded },
        volume: Math.min(1000, player.volume),
        filters: filtersPayload
      }, player.userId);
      player.playing = true;
      player.paused = false;
      this.emit('queueUpdate', player);
    } else {
      player.currentTrack = null;
      player.playing = false;
      player.position = 0;
      await this.sendPlayerUpdate(guildId, {
        track: { encoded: null }
      }, player.userId);
      this.emit('queueEnd', player);
    }
  }

  async apiRequest(path, method = 'GET', body = null) {
    const url = `${this.httpUrl}${path}`;
    const options = {
      method,
      headers: {
        'Authorization': this.auth,
        'Content-Type': 'application/json'
      }
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Lavalink REST ${res.status}: ${errText}`);
    }

    if (res.status === 204) return null;
    return await res.json();
  }

  async loadTracks(identifier) {
    let cleanId = identifier.trim();
    if (!/^https?:\/\//i.test(cleanId) && !cleanId.includes(':')) {
      cleanId = `ytsearch:${cleanId}`;
    }

    const path = `/v4/loadtracks?identifier=${encodeURIComponent(cleanId)}`;
    const result = await this.apiRequest(path, 'GET');
    
    let tracks = [];
    let playlistInfo = null;

    if (result.loadType === 'track') {
      tracks = [result.data];
    } else if (result.loadType === 'playlist') {
      tracks = result.data.tracks || [];
      playlistInfo = result.data.info || null;
    } else if (result.loadType === 'search') {
      tracks = Array.isArray(result.data) ? result.data : [];
    }

    return {
      loadType: result.loadType,
      playlistInfo,
      tracks: tracks.map(t => ({
        encoded: t.encoded,
        info: {
          title: t.info?.title || "Unknown Title",
          author: t.info?.author || "Unknown Artist",
          length: t.info?.length || 0,
          identifier: t.info?.identifier,
          isSeekable: t.info?.isSeekable ?? true,
          isStream: t.info?.isStream ?? false,
          uri: t.info?.uri || "",
          artworkUrl: t.info?.artworkUrl || `https://img.youtube.com/vi/${t.info?.identifier}/hqdefault.jpg`,
          sourceName: t.info?.sourceName || "unknown"
        }
      }))
    };
  }

  // --- Voice State Update for a Guild ---
  async updateVoice(guildId, voiceData) {
    let player = this.players.get(guildId);
    if (!player) {
      player = this.createPlayer(guildId, {
        userId: voiceData.userId,
        channelId: voiceData.channelId
      });
    }

    player.voice = voiceData;
    if (voiceData.userId) player.userId = voiceData.userId;
    if (voiceData.channelId) player.channelId = voiceData.channelId;

    const session = this.getSessionForUser(player.userId);
    if (!session || !session.sessionId) {
      logger.warn('LAVALINK', `Session for user ${player.userId} not ready yet. Queuing voice handshake.`);
      return;
    }

    try {
      logger.info('LAVALINK', `Sending Voice Handshake for Guild ${guildId} to Lavalink session ${session.sessionId}...`);
      
      const payload = {
        voice: {
          token: voiceData.token,
          endpoint: voiceData.endpoint,
          sessionId: voiceData.sessionId,
          channelId: voiceData.channelId || player.channelId
        }
      };

      await this.sendPlayerUpdate(guildId, payload, player.userId);
      logger.success('LAVALINK', `✅ Voice connected in Guild ${guildId} (Channel: ${payload.voice.channelId})!`);
    } catch (err) {
      logger.error('LAVALINK', `Failed to send voice update: ${err.message}`);
    }
  }

  async resyncPlayersForUser(userId) {
    for (const [guildId, player] of this.players.entries()) {
      if (player.userId === userId && player.voice?.token && player.voice?.endpoint) {
        try {
          await this.updateVoice(guildId, player.voice);
        } catch (e) {}
      }
    }
  }

  createPlayer(guildId, options = {}) {
    if (this.players.has(guildId)) {
      const p = this.players.get(guildId);
      if (options.accountId) p.accountId = options.accountId;
      if (options.channelId) p.channelId = options.channelId;
      if (options.userId) p.userId = options.userId;
      return p;
    }

    const player = {
      guildId,
      accountId: options.accountId || null,
      userId: options.userId || null,
      channelId: options.channelId || null,
      playing: false,
      paused: false,
      volume: 100,
      position: 0,
      ping: 0,
      connected: false,
      loop: 'off',
      currentTrack: null,
      queue: [],
      voice: null,
      filters: {
        clarity: false,
        bassboost: false,
        nightcore: false,
        vaporwave: false,
        eightD: false,
        extremeLoud: false,
        packing: false
      }
    };

    this.players.set(guildId, player);
    return player;
  }

  getPlayer(guildId) {
    return this.players.get(guildId);
  }

  async sendPlayerUpdate(guildId, data, userId = null) {
    const session = this.getSessionForUser(userId);
    if (!session || !session.sessionId) {
      throw new Error('Lavalink session not established for this bot');
    }
    const path = `/v4/sessions/${session.sessionId}/players/${guildId}?noReplace=false`;
    return await this.apiRequest(path, 'PATCH', data);
  }

  async play(guildId, track, options = {}) {
    const player = this.createPlayer(guildId, options);

    if (player.playing && !options.noReplace) {
      player.queue.push(track);
      this.emit('queueUpdate', player);
      return { status: 'queued', track };
    } else {
      player.currentTrack = track;
      player.position = 0;
      const filtersPayload = this.buildFiltersPayload(player);
      await this.sendPlayerUpdate(guildId, {
        track: { encoded: track.encoded },
        volume: Math.min(1000, player.volume),
        filters: filtersPayload
      }, player.userId);
      player.playing = true;
      player.paused = false;
      this.emit('trackStart', { player, track });
      return { status: 'playing', track };
    }
  }

  async addPlaylist(guildId, tracks, options = {}) {
    const player = this.createPlayer(guildId, options);
    if (!tracks || tracks.length === 0) return;

    if (!player.playing) {
      const first = tracks[0];
      const rest = tracks.slice(1);
      player.queue.push(...rest);
      await this.play(guildId, first, options);
    } else {
      player.queue.push(...tracks);
      this.emit('queueUpdate', player);
    }
  }

  async pause(guildId, paused = true) {
    const player = this.players.get(guildId);
    if (!player) return;

    await this.sendPlayerUpdate(guildId, { paused }, player.userId);
    player.paused = paused;
    this.emit('playerUpdate', player);
  }

  async skip(guildId) {
    const player = this.players.get(guildId);
    if (!player) return;
    await this.playNext(guildId);
  }

  async stop(guildId) {
    const player = this.players.get(guildId);
    if (!player) return;

    player.queue = [];
    player.currentTrack = null;
    player.playing = false;
    player.position = 0;

    await this.sendPlayerUpdate(guildId, {
      track: { encoded: null }
    }, player.userId);
    this.emit('queueUpdate', player);
  }

  buildFiltersPayload(player) {
    const filtersPayload = {};

    // 1. Raw DSP Volume Multiplier (filters.volume in Lavalink v4)
    // Kept at a clean, high multiplier without digital clipping distortion
    let volMultiplier = Math.max(0.05, player.volume / 100.0);

    if (player.filters.extremeLoud || player.filters.packing) {
      volMultiplier = 3.8; // Clean extreme loudness without harsh clipping
    } else {
      volMultiplier = Math.min(3.8, volMultiplier);
    }

    filtersPayload.volume = Number(volMultiplier.toFixed(2));

    // 2. Channel Mixing (Stereo clarity enhancement without muddy mono phase buildup)
    if (player.filters.extremeLoud) {
      filtersPayload.channelMix = {
        leftToLeft: 1.25,
        leftToRight: 0.15,
        rightToLeft: 0.15,
        rightToRight: 1.25
      };
    } else if (player.filters.packing) {
      filtersPayload.channelMix = {
        leftToLeft: 1.35,
        leftToRight: 0.20,
        rightToLeft: 0.20,
        rightToRight: 1.35
      };
    } else if (player.volume > 150) {
      filtersPayload.channelMix = {
        leftToLeft: 1.15,
        leftToRight: 0.10,
        rightToLeft: 0.10,
        rightToRight: 1.15
      };
    } else {
      filtersPayload.channelMix = {
        leftToLeft: 1.0,
        leftToRight: 0.0,
        rightToLeft: 0.0,
        rightToRight: 1.0
      };
    }

    // 3. Equalizer Bands - BASS REMOVED & CLEAN CRYSTAL VOCAL/TREBLE EXTREME
    if (player.filters.extremeLoud) {
      // Aggressive low-cut (sub-bass & boomy bass removed), heavy vocal & treble presence
      filtersPayload.equalizer = [
        { band: 0, gain: -0.28 }, // 25 Hz  - Sub-bass rumble removed
        { band: 1, gain: -0.24 }, // 40 Hz  - Deep bass cut
        { band: 2, gain: -0.18 }, // 63 Hz  - Boomy bass cut
        { band: 3, gain: -0.08 }, // 100 Hz - Upper bass reduced
        { band: 4, gain: 0.00 },  // 160 Hz - Neutral transition
        { band: 5, gain: 0.18 },  // 250 Hz - Low mid presence
        { band: 6, gain: 0.28 },  // 400 Hz - Vocal warmth
        { band: 7, gain: 0.38 },  // 630 Hz - Vocal body
        { band: 8, gain: 0.48 },  // 1.0 kHz - Crystal vocal clarity
        { band: 9, gain: 0.55 },  // 1.6 kHz - High speech definition
        { band: 10, gain: 0.55 }, // 2.5 kHz - Razor-sharp edge
        { band: 11, gain: 0.50 }, // 4.0 kHz - Crisp brightness
        { band: 12, gain: 0.45 }, // 6.3 kHz - Treble clarity
        { band: 13, gain: 0.40 }, // 10 kHz  - Top air
        { band: 14, gain: 0.35 }  // 16 kHz  - Ultra-high definition
      ];
    } else if (player.filters.packing) {
      // Packing voice-cut EQ (Bass fully removed, maximum voice projection)
      filtersPayload.equalizer = [
        { band: 0, gain: -0.30 },
        { band: 1, gain: -0.25 },
        { band: 2, gain: -0.20 },
        { band: 3, gain: -0.10 },
        { band: 4, gain: 0.05 },
        { band: 5, gain: 0.25 },
        { band: 6, gain: 0.35 },
        { band: 7, gain: 0.45 },
        { band: 8, gain: 0.55 },
        { band: 9, gain: 0.60 },
        { band: 10, gain: 0.60 },
        { band: 11, gain: 0.55 },
        { band: 12, gain: 0.50 },
        { band: 13, gain: 0.45 },
        { band: 14, gain: 0.40 }
      ];
    } else if (player.filters.clarity) {
      // Crystal Clarity filter (removes muddy bass, boosts high-definition vocal/treble)
      filtersPayload.equalizer = [
        { band: 0, gain: -0.35 },
        { band: 1, gain: -0.30 },
        { band: 2, gain: -0.22 },
        { band: 3, gain: -0.10 },
        { band: 4, gain: 0.05 },
        { band: 5, gain: 0.20 },
        { band: 6, gain: 0.30 },
        { band: 7, gain: 0.40 },
        { band: 8, gain: 0.50 },
        { band: 9, gain: 0.55 },
        { band: 10, gain: 0.55 },
        { band: 11, gain: 0.50 },
        { band: 12, gain: 0.45 },
        { band: 13, gain: 0.40 },
        { band: 14, gain: 0.35 }
      ];
    } else if (player.filters.bassboost) {
      // Explicit bass boost (only if user chooses bassboost)
      filtersPayload.equalizer = [
        { band: 0, gain: 0.45 },
        { band: 1, gain: 0.40 },
        { band: 2, gain: 0.30 },
        { band: 3, gain: 0.20 },
        { band: 4, gain: 0.10 }
      ];
    } else if (player.volume > 200) {
      // Dynamic loudness with bass cut for high volume clarity
      filtersPayload.equalizer = [
        { band: 0, gain: -0.22 },
        { band: 1, gain: -0.18 },
        { band: 2, gain: -0.12 },
        { band: 3, gain: -0.05 },
        { band: 4, gain: 0.02 },
        { band: 5, gain: 0.12 },
        { band: 6, gain: 0.20 },
        { band: 7, gain: 0.28 },
        { band: 8, gain: 0.35 },
        { band: 9, gain: 0.40 },
        { band: 10, gain: 0.40 },
        { band: 11, gain: 0.35 },
        { band: 12, gain: 0.30 },
        { band: 13, gain: 0.25 },
        { band: 14, gain: 0.20 }
      ];
    } else {
      // Standard clean sound with mild sub-bass filter to prevent speaker mud
      filtersPayload.equalizer = [
        { band: 0, gain: -0.15 },
        { band: 1, gain: -0.10 },
        { band: 2, gain: -0.05 },
        { band: 3, gain: 0.00 },
        { band: 7, gain: 0.05 },
        { band: 8, gain: 0.10 },
        { band: 9, gain: 0.10 },
        { band: 10, gain: 0.08 },
        { band: 11, gain: 0.05 }
      ];
    }

    // 4. Timescale
    if (player.filters.nightcore) {
      filtersPayload.timescale = { speed: 1.25, pitch: 1.25, rate: 1.0 };
    } else if (player.filters.vaporwave) {
      filtersPayload.timescale = { speed: 0.85, pitch: 0.80, rate: 1.0 };
    } else {
      filtersPayload.timescale = { speed: 1.0, pitch: 1.0, rate: 1.0 };
    }

    // 5. Rotation
    if (player.filters.eightD) {
      filtersPayload.rotation = { rotationHz: 0.2 };
    } else {
      filtersPayload.rotation = { rotationHz: 0.0 };
    }

    return filtersPayload;
  }

  async setVolume(guildId, volume) {
    let player = this.players.get(guildId);
    if (!player) {
      player = this.createPlayer(guildId);
    }

    const vol = parseInt(volume, 10);
    // Support extreme volume up to 2000%
    const clamped = Math.max(0, Math.min(2000, isNaN(vol) ? 100 : vol));
    player.volume = clamped;

    const filtersPayload = this.buildFiltersPayload(player);

    if (player.userId) {
      try {
        await this.sendPlayerUpdate(guildId, {
          volume: Math.min(1000, clamped),
          filters: filtersPayload
        }, player.userId);
      } catch (e) {}
    }

    logger.success('MUSIC', `Set volume in guild ${guildId} to ${clamped}% (Loudness Multiplier: ${filtersPayload.volume}x)`);
    this.emit('playerUpdate', player);
  }

  async seek(guildId, positionMs) {
    const player = this.players.get(guildId);
    if (!player || !player.currentTrack) return;

    await this.sendPlayerUpdate(guildId, { position: positionMs }, player.userId);
    player.position = positionMs;
    this.emit('playerUpdate', player);
  }

  setLoop(guildId, mode) {
    const player = this.players.get(guildId);
    if (!player) return;

    if (['off', 'track', 'queue'].includes(mode)) {
      player.loop = mode;
      this.emit('playerUpdate', player);
    }
  }

  async applyFilters(guildId, filterName, enabled) {
    let player = this.players.get(guildId);
    if (!player) {
      player = this.createPlayer(guildId);
    }

    player.filters[filterName] = enabled;
    const filtersPayload = this.buildFiltersPayload(player);

    if (player.userId) {
      try {
        await this.sendPlayerUpdate(guildId, {
          volume: Math.min(1000, player.volume),
          filters: filtersPayload
        }, player.userId);
      } catch (e) {}
    }

    logger.success('MUSIC', `Updated filter [${filterName}=${enabled}] in guild ${guildId} (Loudness: ${filtersPayload.volume}x)`);
    this.emit('playerUpdate', player);
  }

  removeQueueTrack(guildId, index) {
    const player = this.players.get(guildId);
    if (!player || !player.queue[index]) return;

    const removed = player.queue.splice(index, 1)[0];
    this.emit('queueUpdate', player);
    return removed;
  }

  clearQueue(guildId) {
    const player = this.players.get(guildId);
    if (!player) return;

    player.queue = [];
    this.emit('queueUpdate', player);
  }

  async destroyPlayer(guildId) {
    const player = this.players.get(guildId);
    if (!player) return;

    try {
      const session = this.getSessionForUser(player.userId);
      if (session && session.sessionId) {
        const path = `/v4/sessions/${session.sessionId}/players/${guildId}`;
        await this.apiRequest(path, 'DELETE');
      }
    } catch (e) {}

    this.players.delete(guildId);
    this.emit('playerDestroy', guildId);
  }
}

module.exports = LavalinkClient;
