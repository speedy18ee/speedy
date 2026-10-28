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

      const headers = {
        'Authorization': this.client.auth,
        'User-Id': String(this.userId),
        'Client-Name': 'Selfbot-Dashboard/2.0'
      };
      if (this.sessionId) {
        headers['Session-Id'] = this.sessionId;
      }

      this.ws = new WebSocket(this.client.wsUrl, { headers });

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
        // Enable Lavalink session resuming so tracks never stop during temporary network disconnects
        this.client.apiRequest(`/v4/sessions/${this.sessionId}`, 'PATCH', {
          resuming: true,
          timeout: 180
        }).catch(err => {
          logger.warn('LAVALINK', `Failed to enable session resuming for User ${this.userId}: ${err.message}`);
        });
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
        if (msg.guildId) {
          const player = this.client.getPlayer(msg.guildId, this.userId);
          if (player && msg.state) {
            if (msg.state.position > (player.position || 0)) {
              player._stuckAttempts = 0;
            }
            player.position = msg.state.position || 0;
            player.ping = msg.state.ping || 0;
            player.connected = msg.state.connected ?? true;
            this.client.emit('playerUpdate', player);
          }
        }
        break;

      case 'event':
        this.client.handleEvent(msg, this.userId);
        break;
    }
  }

  destroy() {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.sessionId = null;
    this.connected = false;
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

  handleEvent(event, sessionUserId = null) {
    const { type, guildId } = event;
    const player = this.getPlayer(guildId, sessionUserId);
    if (!player) return;

    logger.info('MUSIC', `Lavalink event: ${type} for guild ${guildId} [bot: ${player.accountId || sessionUserId || 'unknown'}]`);

    switch (type) {
      case 'TrackStartEvent':
        player.playing = true;
        player.paused = false;
        player._stuckAttempts = 0;
        player._exceptionAttempts = 0;
        this.emit('trackStart', { player, track: event.track, ownerId: player.ownerId, accountId: player.accountId });
        break;

      case 'TrackEndEvent':
        player._stuckAttempts = 0;
        player._exceptionAttempts = 0;
        this.handleTrackEnd(player, event);
        break;

      case 'TrackExceptionEvent':
        logger.warn('MUSIC', `Track stream exception: ${event.exception?.message || 'Unknown'}. Keeping position...`);
        if (player.currentTrack) {
          const resumePos = Math.max(0, player.position || 0);
          this.sendPlayerUpdate(guildId, {
            position: resumePos,
            paused: false
          }, player.userId).catch(() => {});
        }
        break;

      case 'TrackStuckEvent':
        logger.warn('MUSIC', `Track buffer stall at ${event.thresholdMs}ms. Resuming smoothly without restart...`);
        if (player.currentTrack) {
          const resumePos = Math.max(0, player.position || 0);
          this.sendPlayerUpdate(guildId, {
            position: resumePos,
            paused: false
          }, player.userId).catch(() => {});
        }
        break;

      case 'WebSocketClosedEvent':
        logger.warn('MUSIC', `Voice channel closed (code ${event.code}): ${event.reason}`);
        break;
    }
  }

  handleTrackEnd(player, event) {
    // 1. Never skip or restart on non-finish reasons (replaced, stopped, cleanup)
    if (event.reason === 'replaced' || event.reason === 'stopped' || event.reason === 'cleanup') {
      return;
    }

    // 2. Prevent premature track breaks in the middle of playback
    const trackDuration = player.currentTrack?.info?.length || 0;
    const currentPos = player.position || 0;
    const isActuallyFinished = event.reason === 'finished' || (trackDuration > 0 && currentPos >= (trackDuration - 4000));

    // If track stopped prematurely in the middle of playback (>4 seconds remaining)
    if (!isActuallyFinished && trackDuration > 10000 && currentPos < (trackDuration - 4000)) {
      logger.warn('MUSIC', `Premature track break prevented at ${Math.round(currentPos/1000)}s / ${Math.round(trackDuration/1000)}s. Resuming audio stream...`);
      player.playing = true;
      player.paused = false;
      return this.sendPlayerUpdate(player.guildId, {
        position: currentPos,
        paused: false
      }, player.userId).catch(() => {});
    }

    // 3. Multi-Bot De-duplication: Ensure only 1 bot in the guild handles track end to keep all bots 100% in sync
    const now = Date.now();
    if (!this._lastTrackEndMap) this._lastTrackEndMap = new Map();
    const lastEnd = this._lastTrackEndMap.get(player.guildId) || 0;
    if (now - lastEnd < 4000) {
      return; // Already processed for this guild!
    }
    this._lastTrackEndMap.set(player.guildId, now);

    player.playing = false;

    // 4. Repeat Loop for track
    if ((player.loop === 'track' || (player.loop === 'queue' && player.queue.length === 0)) && player.currentTrack) {
      const trackToRepeat = player.currentTrack;
      player.position = 0;
      player.playing = true;
      player.paused = false;
      const filtersPayload = this.buildFiltersPayload(player);
      this.sendPlayerUpdate(player.guildId, {
        track: { encoded: trackToRepeat.encoded },
        position: 0,
        paused: false,
        volume: Math.min(1000, Math.max(10, player.volume)),
        filters: filtersPayload
      }, player.userId).then(() => {
        this.emit('trackStart', { player, track: trackToRepeat, ownerId: player.ownerId, accountId: player.accountId });
        this.emit('playerUpdate', player);
      }).catch(err => {
        logger.error('MUSIC', `Loop repeat track failed: ${err.message}`);
      });
      return;
    }

    if (player.loop === 'queue' && player.currentTrack) {
      player.queue.push(player.currentTrack);
    }

    this.playNext(player);
  }

  async playNext(playerOrGuildId, identifier = null, ownerId = null) {
    const player = (typeof playerOrGuildId === 'object' && playerOrGuildId !== null)
      ? playerOrGuildId
      : this.getPlayer(playerOrGuildId, identifier, ownerId);
    if (!player) return;
    const guildId = player.guildId;

    if (player.queue.length > 0) {
      const nextTrack = player.queue.shift();
      player.currentTrack = nextTrack;
      player.position = 0;
      const filtersPayload = this.buildFiltersPayload(player);
      await this.sendPlayerUpdate(guildId, {
        track: { encoded: nextTrack.encoded },
        volume: Math.min(1000, Math.max(10, player.volume)),
        filters: filtersPayload
      }, player.userId);
      player.playing = true;
      player.paused = false;
      this.emit('queueUpdate', player);
      this.emit('trackStart', { player, track: nextTrack, ownerId: player.ownerId, accountId: player.accountId });
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
    const isDirectUrl = /^https?:\/\//i.test(cleanId) || cleanId.includes(':');

    let result = null;
    if (isDirectUrl) {
      result = await this.apiRequest(`/v4/loadtracks?identifier=${encodeURIComponent(cleanId)}`, 'GET');
    } else {
      // Fallback chain: ytsearch -> ytmsearch -> scsearch
      const searchPrefixes = ['ytsearch', 'ytmsearch', 'scsearch'];
      for (const prefix of searchPrefixes) {
        try {
          const res = await this.apiRequest(`/v4/loadtracks?identifier=${encodeURIComponent(`${prefix}:${cleanId}`)}`, 'GET');
          if (res && res.data && (Array.isArray(res.data) ? res.data.length > 0 : (res.data.tracks?.length > 0 || res.data.encoded))) {
            result = res;
            break;
          }
        } catch (_) {}
      }
      if (!result) {
        result = await this.apiRequest(`/v4/loadtracks?identifier=${encodeURIComponent(`ytsearch:${cleanId}`)}`, 'GET');
      }
    }
    
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
    let player = this.getPlayer(guildId, voiceData.accountId || voiceData.userId, voiceData.ownerId);
    if (!player) {
      player = this.createPlayer(guildId, {
        accountId: voiceData.accountId,
        userId: voiceData.userId,
        channelId: voiceData.channelId,
        ownerId: voiceData.ownerId
      });
    }

    player.voice = voiceData;
    if (voiceData.userId) player.userId = voiceData.userId;
    if (voiceData.channelId) player.channelId = voiceData.channelId;
    if (voiceData.accountId) player.accountId = voiceData.accountId;
    if (voiceData.ownerId) player.ownerId = voiceData.ownerId;

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
    for (const [key, player] of this.players.entries()) {
      if (player.userId === userId && player.voice?.token && player.voice?.endpoint) {
        try {
          await this.updateVoice(player.guildId, player.voice);
        } catch (e) {}
      }
    }
  }

  createPlayer(guildId, options = {}) {
    const accountId = options.accountId || null;
    const userId = options.userId || null;
    const ownerId = options.ownerId || null;
    const idKey = accountId || userId;
    const key = idKey ? `${guildId}:${idKey}` : `${guildId}`;

    let player = this.getPlayer(guildId, idKey, ownerId);

    if (player) {
      if (accountId) player.accountId = accountId;
      if (options.channelId) player.channelId = options.channelId;
      if (userId) player.userId = userId;
      if (ownerId) player.ownerId = ownerId;
      if (!this.players.has(key)) this.players.set(key, player);
      return player;
    }

    player = {
      guildId,
      playerKey: key,
      accountId: accountId,
      ownerId: ownerId,
      userId: userId,
      channelId: options.channelId || null,
      playing: false,
      paused: false,
      volume: 1000,
      position: 0,
      ping: 0,
      connected: false,
      loop: 'off',
      currentTrack: null,
      queue: [],
      voice: null,
      filters: {
        clarity: false,
        bassboost: true,
        nightcore: false,
        vaporwave: false,
        eightD: false,
        extremeLoud: false,
        packing: false
      }
    };

    this.players.set(key, player);
    if (accountId) this.players.set(`${guildId}:${accountId}`, player);
    if (userId) this.players.set(`${guildId}:${userId}`, player);
    if (!this.players.has(guildId)) this.players.set(guildId, player);
    return player;
  }

  getPlayer(guildId, identifier = null, ownerId = null) {
    if (identifier) {
      const compositeKey = `${guildId}:${identifier}`;
      if (this.players.has(compositeKey)) {
        const p = this.players.get(compositeKey);
        if (!ownerId || !p.ownerId || p.ownerId === ownerId) return p;
      }
      if (this.players.has(identifier)) {
        const p = this.players.get(identifier);
        if (!ownerId || !p.ownerId || p.ownerId === ownerId) return p;
      }
    }

    // Search by guildId and matching identifier and ownerId
    for (const [k, p] of this.players.entries()) {
      if (p.guildId === guildId) {
        if (identifier) {
          if (p.accountId === identifier || p.userId === identifier) {
            if (!ownerId || !p.ownerId || p.ownerId === ownerId) {
              return p;
            }
          }
        } else if (ownerId) {
          if (p.ownerId === ownerId) {
            return p;
          }
        }
      }
    }

    // Fallback only if neither identifier nor ownerId was requested
    if (!identifier && !ownerId) {
      return this.players.get(guildId) || null;
    }

    return null;
  }

  async sendPlayerUpdate(guildId, data, userId = null) {
    const session = this.getSessionForUser(userId);
    if (!session || !session.sessionId) {
      throw new Error('Lavalink session not established for this bot');
    }
    const path = `/v4/sessions/${session.sessionId}/players/${guildId}?noReplace=${data.track ? "false" : "true"}`;
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
      const isPaused = options.startPaused === true;
      await this.sendPlayerUpdate(guildId, {
        track: { encoded: track.encoded },
        position: 0,
        paused: isPaused,
        volume: Math.min(1000, Math.max(10, player.volume)),
        filters: filtersPayload
      }, player.userId);
      player.playing = true;
      player.paused = isPaused;
      this.emit('trackStart', { player, track });
      return { status: isPaused ? 'buffered' : 'playing', track };
    }
  }

  async addPlaylist(guildId, tracks, options = {}) {
    const player = this.createPlayer(guildId, options);
    if (!tracks || tracks.length === 0) return;

    if (!player.playing || options.noReplace) {
      const first = tracks[0];
      const rest = tracks.slice(1);
      player.queue = [...rest];
      await this.play(guildId, first, { ...options, noReplace: true });
    } else {
      player.queue.push(...tracks);
      this.emit('queueUpdate', player);
    }
  }

  async pause(guildId, paused = true, identifier = null, ownerId = null) {
    const player = this.getPlayer(guildId, identifier, ownerId);
    if (!player) return;

    await this.sendPlayerUpdate(guildId, { paused }, player.userId);
    player.paused = paused;
    this.emit('playerUpdate', player);
  }

  async skip(guildId, identifier = null, ownerId = null) {
    const player = this.getPlayer(guildId, identifier, ownerId);
    if (!player) return;
    await this.playNext(player);
  }

  async stop(guildId, identifier = null, ownerId = null) {
    const player = this.getPlayer(guildId, identifier, ownerId);
    if (!player) return;

    player.queue = [];
    player.currentTrack = null;
    player.playing = false;
    player.position = 0;

    await this.sendPlayerUpdate(guildId, {
      track: { encoded: null }
    }, player.userId);
    this.emit('queueUpdate', player);
    this.emit('playerUpdate', player);
  }

  buildFiltersPayload(player) {
    const filtersPayload = {};

    // 1. Raw DSP Volume Multiplier (filters.volume in Lavalink v4)
    // Capped at 5.0 max (500%) because lavadsp VolumePcmAudioFilter strictly enforces [0.0 - 5.0]
    let volMultiplier = Math.max(0.05, player.volume / 100.0);
    volMultiplier = Math.min(5.0, Math.max(0.05, volMultiplier));
    filtersPayload.volume = Number(volMultiplier.toFixed(2));

    // Support DoubleBlast / Blast / SuperLoud / ForceLoud Volume Multipliers
    if (player.filters.doubleblast) {
      filtersPayload.volume = 5.0;
      filtersPayload.channelMix = { leftToLeft: 3.5, rightToRight: 3.5, leftToRight: 1.0, rightToLeft: 1.0 };
      filtersPayload.distortion = { sinScale: 0.35, cosScale: 0.35, offset: 0.1, scale: 3.0 };
    } else if (player.filters.blast) {
      filtersPayload.volume = 5.0;
      filtersPayload.channelMix = { leftToLeft: 2.5, rightToRight: 2.5, leftToRight: 0.5, rightToLeft: 0.5 };
      filtersPayload.distortion = { sinScale: 0.25, cosScale: 0.25, offset: 0.05, scale: 2.0 };
    } else if (player.filters.forceLoud) {
      filtersPayload.volume = 5.0;
      filtersPayload.channelMix = { leftToLeft: 4.0, rightToRight: 4.0, leftToRight: 1.2, rightToLeft: 1.2 };
    } else if (player.filters.superLoud) {
      filtersPayload.volume = 5.0;
      filtersPayload.channelMix = { leftToLeft: 3.0, rightToRight: 3.0, leftToRight: 0.8, rightToLeft: 0.8 };
    } else if (player.filters.pungi) {
      filtersPayload.volume = 5.0;
      filtersPayload.channelMix = { leftToLeft: 2.0, rightToRight: 2.0, leftToRight: 0.6, rightToLeft: 0.6 };
      filtersPayload.distortion = { sinScale: 0.8, cosScale: 0.7, tanScale: 0.5, offset: 0.2, scale: 3.0 };
      filtersPayload.rotation = { rotationHz: 0.5 };
      filtersPayload.timescale = { speed: 1.0, pitch: 1.08, rate: 1.0 };
    }

    // 2. Channel Mixing (Stereo enhancement & maximum loudness gain)
    if (player.filters.extremeLoud || player.volume >= 500) {
      filtersPayload.channelMix = {
        leftToLeft: 1.5,
        leftToRight: 0.25,
        rightToLeft: 0.25,
        rightToRight: 1.5
      };
    } else if (player.volume > 150) {
      filtersPayload.channelMix = {
        leftToLeft: 1.25,
        leftToRight: 0.15,
        rightToLeft: 0.15,
        rightToRight: 1.25
      };
    } else {
      filtersPayload.channelMix = {
        leftToLeft: 1.0,
        leftToRight: 0.0,
        rightToLeft: 0.0,
        rightToRight: 1.0
      };
    }

    // 3. Equalizer Bands - Heavy 15dB 60Hz Bass Punch + Maximum Loudness Clarity
    if (player.filters.bassboost) {
      // Exact heavy 15dB 60Hz punch curve matching ganil/synced_cluster.js
      filtersPayload.equalizer = [
        { band: 0, gain: 0.80 }, // 25 Hz sub-bass rumble
        { band: 1, gain: 0.95 }, // 40 Hz deep bass drop
        { band: 2, gain: 1.00 }, // 63 Hz peak punch (exact 15dB kick)
        { band: 3, gain: 0.80 }, // 100 Hz punch
        { band: 4, gain: 0.45 }, // 160 Hz upper punch
        { band: 5, gain: 0.20 }, // 250 Hz low mid
        { band: 6, gain: 0.15 }, // 400 Hz warmth
        { band: 7, gain: 0.25 }, // 630 Hz vocal body
        { band: 8, gain: 0.35 }, // 1.0 kHz crystal vocal
        { band: 9, gain: 0.40 }, // 1.6 kHz presence
        { band: 10, gain: 0.45 }, // 2.5 kHz razor edge
        { band: 11, gain: 0.40 }, // 4.0 kHz crisp highs
        { band: 12, gain: 0.35 }, // 6.3 kHz treble air
        { band: 13, gain: 0.30 }, // 10 kHz
        { band: 14, gain: 0.25 }  // 16 kHz
      ];
    } else if (player.filters.extremeLoud) {
      // Aggressive low-cut only when bassboost is explicitly turned off
      filtersPayload.equalizer = [
        { band: 0, gain: -0.28 },
        { band: 1, gain: -0.24 },
        { band: 2, gain: -0.18 },
        { band: 3, gain: -0.08 },
        { band: 4, gain: 0.00 },
        { band: 5, gain: 0.18 },
        { band: 6, gain: 0.28 },
        { band: 7, gain: 0.38 },
        { band: 8, gain: 0.48 },
        { band: 9, gain: 0.55 },
        { band: 10, gain: 0.55 },
        { band: 11, gain: 0.50 },
        { band: 12, gain: 0.45 },
        { band: 13, gain: 0.40 },
        { band: 14, gain: 0.35 }
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

  async setVolume(guildId, volume, identifier = null, ownerId = null) {
    let player = this.getPlayer(guildId, identifier, ownerId);
    if (!player) {
      player = this.createPlayer(guildId, { accountId: identifier, ownerId });
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

  async seek(guildId, positionMs, identifier = null, ownerId = null) {
    const player = this.getPlayer(guildId, identifier, ownerId);
    if (!player || !player.currentTrack) return;

    await this.sendPlayerUpdate(guildId, { position: positionMs }, player.userId);
    player.position = positionMs;
    this.emit('playerUpdate', player);
  }

  setLoop(guildId, mode, identifier = null, ownerId = null) {
    if (!['off', 'track', 'queue'].includes(mode)) return;

    if (!identifier || identifier === 'ALL_BOTS') {
      for (const [, p] of this.players.entries()) {
        if (p.guildId === guildId && (!ownerId || p.ownerId === ownerId)) {
          p.loop = mode;
          this.emit('playerUpdate', p);
        }
      }
    } else {
      const player = this.getPlayer(guildId, identifier, ownerId);
      if (player) {
        player.loop = mode;
        this.emit('playerUpdate', player);
      }
    }
  }

  async applyFilters(guildId, filterName, enabled, identifier = null, ownerId = null) {
    let player = this.getPlayer(guildId, identifier, ownerId);
    if (!player) {
      player = this.createPlayer(guildId, { accountId: identifier, ownerId });
    }

    player.filters[filterName] = enabled;
    const filtersPayload = this.buildFiltersPayload(player);

    if (player.userId) {
      try {
        await this.sendPlayerUpdate(guildId, {
          volume: Math.min(1000, Math.max(10, player.volume)),
          filters: filtersPayload
        }, player.userId);
      } catch (e) {}
    }

    logger.success('MUSIC', `Updated filter [${filterName}=${enabled}] in guild ${guildId} (Loudness: ${filtersPayload.volume}x)`);
    this.emit('playerUpdate', player);
  }

  removeQueueTrack(guildId, index, identifier = null, ownerId = null) {
    const player = this.getPlayer(guildId, identifier, ownerId);
    if (!player || !player.queue[index]) return;

    const removed = player.queue.splice(index, 1)[0];
    this.emit('queueUpdate', player);
    return removed;
  }

  clearQueue(guildId, identifier = null, ownerId = null) {
    const player = this.getPlayer(guildId, identifier, ownerId);
    if (!player) return;

    player.queue = [];
    this.emit('queueUpdate', player);
  }

  async destroyPlayer(guildId, identifier = null, ownerId = null) {
    const player = this.getPlayer(guildId, identifier, ownerId);
    if (!player) return;

    try {
      const session = this.getSessionForUser(player.userId);
      if (session && session.sessionId) {
        const path = `/v4/sessions/${session.sessionId}/players/${guildId}`;
        await this.apiRequest(path, 'DELETE');
      }
    } catch (e) {}

    if (player.playerKey) this.players.delete(player.playerKey);
    if (player.accountId) this.players.delete(`${guildId}:${player.accountId}`);
    if (player.userId) this.players.delete(`${guildId}:${player.userId}`);
    if (this.players.get(guildId) === player) {
      this.players.delete(guildId);
      for (const p of this.players.values()) {
        if (p.guildId === guildId) {
          this.players.set(guildId, p);
          break;
        }
      }
    }
    this.emit('playerDestroy', { guildId, accountId: player.accountId, ownerId: player.ownerId });
  }
}

module.exports = LavalinkClient;
