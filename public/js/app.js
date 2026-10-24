// State Store
const state = {
  accounts: [],
  lavalink: null,
  activeTab: 'overview',
  selectedMusicBotId: null,
  selectedGuildId: null,
  activePlayer: null,
  currentTrackPosition: 0,
  currentTrackDuration: 0,
  isSeeking: false,
  positionInterval: null,
  logFilter: 'ALL',
  autoScroll: true,
  token: localStorage.getItem('exc_user_token') || null,
  currentUser: null
};

// Global Fetch Interceptor for EXC Authentication
const _originalFetch = window.fetch;
window.fetch = async function(url, options = {}) {
  options = options || {};
  options.headers = options.headers || {};
  if (state.token) {
    if (options.headers instanceof Headers) {
      if (!options.headers.has('Authorization')) {
        options.headers.set('Authorization', `Bearer ${state.token}`);
      }
    } else {
      if (!options.headers['Authorization'] && !options.headers['authorization']) {
        options.headers['Authorization'] = `Bearer ${state.token}`;
      }
    }
  }
  const response = await _originalFetch(url, options);
  if (response.status === 401 && !url.includes('/api/auth/login')) {
    showLoginOverlay();
  }
  return response;
};

// Authentication & HWID UI Handlers
function showLoginOverlay() {
  const overlay = document.getElementById('exc-login-overlay');
  if (overlay) overlay.style.display = 'flex';
}

function hideLoginOverlay() {
  const overlay = document.getElementById('exc-login-overlay');
  if (overlay) overlay.style.display = 'none';
}

function toggleLoginPasswordView() {
  const pwdInput = document.getElementById('login-password');
  const eye = document.getElementById('login-eye-icon');
  if (pwdInput.type === 'password') {
    pwdInput.type = 'text';
    eye.className = 'fa-solid fa-eye-slash';
  } else {
    pwdInput.type = 'password';
    eye.className = 'fa-solid fa-eye';
  }
}

async function handleUserLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value.trim();
  const errBox = document.getElementById('login-error-msg');
  const submitBtn = document.getElementById('btn-login-submit');

  errBox.style.display = 'none';
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking HWID Lock...';

  try {
    const hwid = await window.getDeviceHwid();
    const deviceInfo = window.getDeviceInfo();

    const res = await _originalFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, hwid, deviceInfo })
    });

    const data = await res.json();
    if (data.success && data.token) {
      state.token = data.token;
      state.currentUser = data.user;
      state.botLimit = data.user?.botLimit || 10;
      localStorage.setItem('exc_user_token', data.token);

      const userSpan = document.getElementById('sidebar-user-name');
      if (userSpan) userSpan.textContent = data.user.username;
      const mobUserSpan = document.getElementById('mobile-username-text');
      if (mobUserSpan) mobUserSpan.textContent = data.user.username;

      hideLoginOverlay();
      renderStats();
      showToast(`Welcome to EXC, ${data.user.username}! (Plan: ${state.botLimit} Bots Limit)`, 'success');

      if (!ws) initWebSocket();
      fetchAccounts();
      loadActivePlayer();
    } else {
      errBox.textContent = data.error || 'Login failed. Please check credentials.';
      errBox.style.display = 'block';
    }
  } catch (err) {
    errBox.textContent = 'Connection error: ' + err.message;
    errBox.style.display = 'block';
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Login to EXC';
  }
}

async function checkUserAuth() {
  if (!state.token) {
    window.location.href = '/login';
    return;
  }
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (data.success && data.user) {
      state.currentUser = data.user;
      state.botLimit = data.user?.botLimit || 10;
      const userSpan = document.getElementById('sidebar-user-name');
      if (userSpan) userSpan.textContent = data.user.username;
      const mobUserSpan = document.getElementById('mobile-username-text');
      if (mobUserSpan) mobUserSpan.textContent = data.user.username;
      hideLoginOverlay();
      renderStats();
      initWebSocket();
      fetchAccounts();
    } else {
      localStorage.removeItem('exc_user_token');
      window.location.href = '/login';
    }
  } catch (e) {
    localStorage.removeItem('exc_user_token');
    window.location.href = '/login';
  }
}

function logoutEXC() {
  if (state.token) {
    _originalFetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` }
    }).catch(() => {});
  }
  localStorage.removeItem('exc_user_token');
  state.token = null;
  state.currentUser = null;
  if (ws) {
    ws.close();
    ws = null;
  }
  window.location.href = '/login?logout=1';
}

// WebSocket setup
let ws = null;

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);
  window.ws = ws;
  window.dashboardWs = ws;

  ws.onopen = () => {
    console.log('[WS] Connected to dashboard server');
    if (state.token) {
      ws.send(JSON.stringify({ type: 'auth', token: state.token }));
    }
  };

  ws.onmessage = (event) => {
    try {
      const { type, data } = JSON.parse(event.data);
      handleServerEvent(type, data);
    } catch (err) {
      console.error('[WS] Error processing message:', err);
    }
  };

  ws.onclose = () => {
    console.warn('[WS] Connection closed, retrying in 3s...');
    setTimeout(initWebSocket, 3000);
  };
}

// Handle server broadcast events
function handleServerEvent(type, data) {
  switch (type) {
    case 'init':
      state.accounts = data.accounts || [];
      state.lavalink = data.lavalink || null;
      renderAllAccounts();
      renderVoiceManagerCards();
      renderStats();
      renderLavalinkStatus();
      if (data.logs) {
        data.logs.forEach(appendLogEntry);
      }
      break;

    case 'botStatus':
      const acc = state.accounts.find(a => a.id === data.accountId);
      if (acc) {
        acc.status = data.status;
        if (data.user) acc.user = data.user;
        if (data.ping !== undefined) acc.ping = data.ping;
        updateAccountCard(acc);
        renderStats();
        populateMusicBotSelect();
      }
      break;

    case 'botVoice':
      const accV = state.accounts.find(a => a.id === data.accountId);
      if (accV) {
        accV.currentVoice = data.currentVoice;
        updateAccountCard(accV);
        renderVoiceManagerCards();
        renderStats();
      }
      break;

    case 'lavalinkStats':
      if (state.lavalink) {
        state.lavalink.stats = data;
        renderLavalinkStatus();
        renderStats();
      }
      break;

    case 'lavalinkReady':
      if (state.lavalink) {
        state.lavalink.connected = true;
        state.lavalink.sessionId = data.sessionId;
        renderLavalinkStatus();
      }
      break;

    case 'lavalinkDisconnect':
      if (state.lavalink) {
        state.lavalink.connected = false;
        renderLavalinkStatus();
      }
      break;

    case 'playerUpdate':
      if (data.guildId === state.selectedGuildId) {
        updatePlayerUI(data);
      }
      break;

    case 'trackStart':
      if (data.player?.guildId === state.selectedGuildId) {
        updateNowPlayingUI(data.player);
      }
      break;

    case 'queueUpdate':
      if (data.guildId === state.selectedGuildId) {
        renderQueue(data);
      }
      break;

    case 'queueEnd':
      if (data.guildId === state.selectedGuildId) {
        resetPlayerUI();
      }
      break;

    case 'log':
      appendLogEntry(data);
      break;

    case 'logsCleared':
      document.getElementById('terminal-stream').innerHTML = '';
      document.getElementById('overview-logs-preview').innerHTML = '';
      break;

    case 'userLimitUpdated':
      if (state.currentUser && (state.currentUser.id === data.userId || state.currentUser.username === data.username)) {
        state.botLimit = data.botLimit;
        state.currentUser.botLimit = data.botLimit;
        renderStats();
        showToast(`🤖 Your bot account limit has been updated to ${data.botLimit} bots!`, 'info');
      }
      break;
  }
}

// --- Navigation ---
function switchTab(tabId) {
  state.activeTab = tabId;

  document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.tab === tabId);
  });

  document.querySelectorAll('.mobile-bottom-nav .mob-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.tab === tabId);
  });

  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.remove('active');
  });

  const activePane = document.getElementById(`tab-${tabId}`);
  if (activePane) activePane.classList.add('active');

  const titles = {
    overview: ['Dashboard Overview', 'EXC 24/7 Multi-Account & Audio Controller'],
    accounts: ['Multi-Account Manager', 'Configure Discord Tokens, Status & Presences'],
    voice: ['24/7 Voice Stay Controller', 'Keep accounts connected to Voice Channels indefinitely'],
    music: ['Music Player Deck', 'High fidelity music playback & extreme volume audio filters'],
    settings: ['System & Audio Settings', 'Customize voice auto-reconnect and playback options']
  };

  const [t, sub] = titles[tabId] || ['Dashboard', ''];
  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = t;
  const subEl = document.getElementById('page-subtitle');
  if (subEl) subEl.textContent = sub;

  if (tabId === 'music') {
    populateMusicBotSelect();
  }
}
window.switchTab = switchTab;

function setupNavigationListeners() {
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab(link.dataset.tab);
    });
  });

  document.querySelectorAll('.mobile-bottom-nav .mob-nav-item').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab(link.dataset.tab);
    });
  });
}

// Bind immediately and on DOMContentLoaded
setupNavigationListeners();
document.addEventListener('DOMContentLoaded', setupNavigationListeners);

window.addEventListener('hashchange', () => {
  const hash = window.location.hash.replace('#', '');
  if (['overview', 'accounts', 'voice', 'music', 'settings'].includes(hash)) {
    switchTab(hash);
  }
});

// --- RENDER STATS ---
function renderStats() {
  const total = state.accounts.length;
  const limit = state.botLimit || state.currentUser?.botLimit || 10;
  const online = state.accounts.filter(a => a.status === 'online').length;
  const inVoice = state.accounts.filter(a => a.currentVoice && a.currentVoice.channelId).length;
  const stay247 = state.accounts.filter(a => a.voice247?.enabled).length;

  const elTotal = document.getElementById('stat-total-accounts');
  if (elTotal) elTotal.textContent = total;
  const elLimit = document.getElementById('stat-limit-accounts');
  if (elLimit) elLimit.textContent = limit;
  const elOnline = document.getElementById('stat-online-accounts');
  if (elOnline) elOnline.textContent = `${online} Online • ${limit} Bots Limit`;
  const elBadgeCount = document.getElementById('badge-accounts-count');
  if (elBadgeCount) elBadgeCount.textContent = total;

  const elQuotaCounter = document.getElementById('lbl-quota-counter');
  if (elQuotaCounter) elQuotaCounter.textContent = `${total} / ${limit} Bots`;

  const elSidebarQuota = document.getElementById('lbl-sidebar-quota');
  if (elSidebarQuota) elSidebarQuota.textContent = `${total} / ${limit} Bots`;

  const elMobileQuota = document.getElementById('lbl-mobile-quota');
  if (elMobileQuota) elMobileQuota.textContent = `${total}/${limit}`;

  const el247 = document.getElementById('stat-247-count');
  if (el247) el247.textContent = `${stay247} Configured`;

  const elMusicActive = document.getElementById('stat-music-active');
  const elMusicTrack = document.getElementById('stat-music-track');
  if (elMusicActive) {
    if (state.activePlayer?.playing) {
      elMusicActive.textContent = 'Playing';
      elMusicActive.style.color = 'var(--success)';
      if (elMusicTrack) elMusicTrack.textContent = state.activePlayer.currentTrack?.info?.title || 'Active Track';
    } else {
      elMusicActive.textContent = 'Idle';
      elMusicActive.style.color = 'var(--text-muted)';
      if (elMusicTrack) elMusicTrack.textContent = 'Ready to play';
    }
  }
}

// --- RENDER LAVALINK STATUS (HIDDEN IN UI) ---
function renderLavalinkStatus() {
  // Elements removed per user preference
}

// --- RENDER ACCOUNTS ---
function renderAllAccounts() {
  const grid = document.getElementById('accounts-grid-container');
  const overviewList = document.getElementById('overview-accounts-list');

  if (state.accounts.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <i class="fa-solid fa-user-astronaut"></i>
        <h3>No Discord accounts added yet</h3>
        <p>Click "Add Account with Token" above to log in your first selfbot!</p>
      </div>`;
    overviewList.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-ghost"></i>
        <p>No accounts configured. Click <b>"Add Account"</b> to get started!</p>
      </div>`;
    return;
  }

  grid.innerHTML = '';
  overviewList.innerHTML = '';

  state.accounts.forEach(acc => {
    grid.appendChild(createAccountCard(acc));
    overviewList.appendChild(createMiniAccountItem(acc));
  });
}

function createAccountCard(acc) {
  const card = document.createElement('div');
  card.className = 'account-card';
  card.id = `acc-card-${acc.id}`;

  const isOnline = acc.status === 'online';
  const avatarUrl = acc.user?.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png';
  const tag = acc.user?.tag || 'Not Logged In';
  const voiceInfo = acc.currentVoice?.channelName
    ? `In Voice: <b>${acc.currentVoice.channelName}</b> (${acc.currentVoice.guildName || 'Server'})`
    : (acc.voice247?.enabled ? `24/7 Configured: ${acc.voice247.channelName || acc.voice247.channelId}` : 'Not in voice');

  card.innerHTML = `
    <div class="acc-card-header">
      <div class="acc-avatar-box">
        <img class="acc-avatar" src="${avatarUrl}" alt="Avatar">
        <span class="avatar-status-dot ${acc.presence?.status || 'offline'}"></span>
      </div>
      <div class="acc-meta">
        <h3 class="acc-label-title">${escapeHTML(acc.label)}</h3>
        <span class="acc-tag-sub font-mono">${escapeHTML(tag)}</span>
      </div>
      <span class="badge ${isOnline ? 'badge-success' : (acc.status === 'error' ? 'badge-danger' : 'badge-warning')}">
        ${acc.status}
      </span>
    </div>

    <div class="acc-voice-status">
      <i class="fa-solid fa-microphone-lines"></i>
      <span class="voice-text">${voiceInfo}</span>
    </div>

    <div class="detail-row" style="margin-bottom:12px;">
      <span class="label">Token:</span>
      <span class="val font-mono" style="font-size:0.75rem;">${acc.tokenMasked || '••••••••'}</span>
    </div>

    <div class="acc-card-actions">
      ${isOnline
        ? `<button class="btn btn-sm btn-outline btn-danger-outline" onclick="stopAccount('${acc.id}')">
            <i class="fa-solid fa-power-off"></i> Stop
           </button>`
        : `<button class="btn btn-sm btn-primary" onclick="startAccount('${acc.id}')">
            <i class="fa-solid fa-play"></i> Start
           </button>`
      }
      <button class="btn btn-sm btn-outline" onclick="openPresenceModal('${acc.id}')" title="Change Presence">
        <i class="fa-solid fa-user-pen"></i> Status
      </button>
      <button class="btn btn-sm btn-outline" onclick="quickJumpToVoice('${acc.id}')" title="24/7 Setup">
        <i class="fa-solid fa-tower-broadcast"></i> 24/7
      </button>
      <button class="btn btn-sm btn-outline btn-danger-outline" onclick="deleteAccount('${acc.id}')" title="Delete">
        <i class="fa-solid fa-trash"></i>
      </button>
    </div>
  `;
  return card;
}

function createMiniAccountItem(acc) {
  const item = document.createElement('div');
  item.className = 'search-item';
  item.style.marginBottom = '6px';
  const avatarUrl = acc.user?.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png';

  item.innerHTML = `
    <img class="search-thumb" src="${avatarUrl}" alt="Avatar" style="border-radius:50%;">
    <div class="search-info">
      <div class="search-title">${escapeHTML(acc.label)}</div>
      <div class="search-author font-mono">${escapeHTML(acc.user?.tag || 'Offline')}</div>
    </div>
    <span class="badge ${acc.status === 'online' ? 'badge-success' : (acc.status === 'error' ? 'badge-danger' : 'badge-warning')}" title="${escapeHTML(acc.error || acc.status)}">${acc.status}</span>
  `;
  return item;
}

function updateAccountCard(acc) {
  const existing = document.getElementById(`acc-card-${acc.id}`);
  if (existing) {
    const parent = existing.parentNode;
    const newCard = createAccountCard(acc);
    parent.replaceChild(newCard, existing);
  } else {
    renderAllAccounts();
  }
}

// --- RENDER 24/7 VOICE MANAGER CARDS ---
async function renderVoiceManagerCards() {
  const container = document.getElementById('voice-manager-cards');
  if (state.accounts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-microphone-slash"></i>
        <p>No accounts available. Add an account first!</p>
      </div>`;
    return;
  }

  container.innerHTML = '';

  for (const acc of state.accounts) {
    const card = document.createElement('div');
    card.className = 'voice-card';
    card.id = `voice-card-${acc.id}`;

    const isOnline = acc.status === 'online';
    const is247 = acc.voice247?.enabled || false;
    const inVoice = acc.currentVoice && acc.currentVoice.channelId;
    const avatarUrl = acc.user?.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png';

    card.innerHTML = `
      <div class="voice-card-profile">
        <img class="acc-avatar" src="${avatarUrl}" alt="Avatar" style="width:48px;height:48px;">
        <div>
          <h4 style="color:#fff;">${escapeHTML(acc.label)}</h4>
          <span class="font-mono" style="font-size:0.75rem;color:var(--text-muted);">${escapeHTML(acc.user?.tag || 'Offline')}</span>
          <div style="margin-top:4px;">
            <span class="badge ${inVoice ? 'badge-success' : 'badge-warning'}">
              ${inVoice ? 'In Channel: ' + escapeHTML(acc.currentVoice.channelName) : 'Not Connected'}
            </span>
          </div>
        </div>
      </div>

      <div class="voice-card-selectors">
        <div class="form-group" style="margin-bottom:0;">
          <label><i class="fa-solid fa-server"></i> Server / Guild</label>
          <select class="form-select voice-guild-select" id="vg-select-${acc.id}" onchange="handleVoiceGuildChange('${acc.id}')" ${!isOnline ? 'disabled' : ''}>
            <option value="">${isOnline ? 'Loading servers...' : 'Bot Offline'}</option>
          </select>
        </div>

        <div class="form-group" style="margin-bottom:0;">
          <label><i class="fa-solid fa-microphone"></i> Voice Channel</label>
          <select class="form-select voice-channel-select" id="vc-select-${acc.id}" ${!isOnline ? 'disabled' : ''}>
            <option value="">Select Channel</option>
          </select>
        </div>
      </div>

      <div class="voice-card-toggles">
        <label class="toggle-checkbox">
          <input type="checkbox" id="toggle-247-${acc.id}" ${is247 ? 'checked' : ''} onchange="toggle247Stay('${acc.id}')">
          <span style="font-weight:700;color:var(--accent-cyan);"><i class="fa-solid fa-infinity"></i> 24/7 Keep-Alive</span>
        </label>

        <div style="display:flex;gap:10px;">
          <label class="toggle-checkbox" style="font-size:0.8rem;">
            <input type="checkbox" id="toggle-mute-${acc.id}" ${acc.voice247?.selfMute ? 'checked' : ''}>
            <span>Self-Mute</span>
          </label>
          <label class="toggle-checkbox" style="font-size:0.8rem;">
            <input type="checkbox" id="toggle-deaf-${acc.id}" ${acc.voice247?.selfDeaf ? 'checked' : ''}>
            <span>Self-Deafen</span>
          </label>
        </div>

        <div style="display:flex;gap:8px;margin-top:4px;">
          <button class="btn btn-sm btn-primary" onclick="connectVoiceDirect('${acc.id}')" ${!isOnline ? 'disabled' : ''}>
            <i class="fa-solid fa-plug"></i> Connect
          </button>
          <button class="btn btn-sm btn-outline btn-danger-outline" onclick="disconnectVoiceDirect('${acc.id}')" ${!inVoice ? 'disabled' : ''}>
            <i class="fa-solid fa-circle-xmark"></i> Leave
          </button>
        </div>
      </div>
    `;

    container.appendChild(card);

    // If online, fetch guilds
    if (isOnline) {
      loadGuildsForVoiceCard(acc.id);
    }
  }
}

async function loadGuildsForVoiceCard(accountId) {
  try {
    const res = await fetch(`/api/accounts/${accountId}/guilds`);
    const data = await res.json();
    if (!data.success) return;

    const guildSelect = document.getElementById(`vg-select-${accountId}`);
    if (!guildSelect) return;

    const acc = state.accounts.find(a => a.id === accountId);
    const savedGuildId = acc?.voice247?.guildId || acc?.currentVoice?.guildId;

    guildSelect.innerHTML = `<option value="">-- Choose Server (${data.guilds.length}) --</option>`;
    data.guilds.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = `${g.name} (${g.voiceChannels.length} voice)`;
      if (g.id === savedGuildId) opt.selected = true;
      guildSelect.appendChild(opt);
    });

    // Store cached guilds on element
    guildSelect._cachedGuilds = data.guilds;

    if (savedGuildId) {
      handleVoiceGuildChange(accountId);
    }
  } catch (err) {
    console.error(`Error loading guilds for ${accountId}:`, err);
  }
}

function handleVoiceGuildChange(accountId) {
  const guildSelect = document.getElementById(`vg-select-${accountId}`);
  const channelSelect = document.getElementById(`vc-select-${accountId}`);
  if (!guildSelect || !channelSelect || !guildSelect._cachedGuilds) return;

  const guild = guildSelect._cachedGuilds.find(g => g.id === guildSelect.value);
  channelSelect.innerHTML = '<option value="">-- Choose Voice Channel --</option>';

  if (!guild) return;

  const acc = state.accounts.find(a => a.id === accountId);
  const savedChannelId = acc?.voice247?.channelId || acc?.currentVoice?.channelId;

  guild.voiceChannels.forEach(ch => {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = `🔊 ${ch.name}`;
    if (ch.id === savedChannelId) opt.selected = true;
    channelSelect.appendChild(opt);
  });
}

async function toggle247Stay(accountId) {
  const toggle = document.getElementById(`toggle-247-${accountId}`);
  const guildSelect = document.getElementById(`vg-select-${accountId}`);
  const channelSelect = document.getElementById(`vc-select-${accountId}`);
  const muteCheck = document.getElementById(`toggle-mute-${accountId}`);
  const deafCheck = document.getElementById(`toggle-deaf-${accountId}`);

  const enabled = toggle.checked;
  const channelId = channelSelect?.value;
  const guildId = guildSelect?.value;

  if (enabled && !channelId) {
    showToast('Please select a Voice Channel first!', 'warn');
    toggle.checked = false;
    return;
  }

  try {
    const res = await fetch(`/api/accounts/${accountId}/voice/247`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        guildId,
        channelId,
        selfMute: muteCheck?.checked || false,
        selfDeaf: deafCheck?.checked || false
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast(enabled ? '24/7 Voice Stay Enabled! Auto-reconnect active.' : '24/7 Voice Stay Disabled.', 'success');
      const acc = state.accounts.find(a => a.id === accountId);
      if (acc) acc.voice247 = data.voice247;
    } else {
      showToast(data.error || 'Failed to update 24/7 state', 'error');
      toggle.checked = !enabled;
    }
  } catch (err) {
    showToast(err.message, 'error');
    toggle.checked = !enabled;
  }
}

async function connectVoiceDirect(accountId) {
  const channelSelect = document.getElementById(`vc-select-${accountId}`);
  const muteCheck = document.getElementById(`toggle-mute-${accountId}`);
  const deafCheck = document.getElementById(`toggle-deaf-${accountId}`);

  const channelId = channelSelect?.value;
  if (!channelId) {
    return showToast('Select a voice channel first!', 'warn');
  }

  try {
    showToast('Joining voice channel...', 'info');
    const res = await fetch(`/api/accounts/${accountId}/voice/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId,
        selfMute: muteCheck?.checked || false,
        selfDeaf: deafCheck?.checked || false
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Connected to Voice Channel!', 'success');
    } else {
      showToast(data.error || 'Failed to join voice', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function disconnectVoiceDirect(accountId) {
  try {
    const res = await fetch(`/api/accounts/${accountId}/voice/leave`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Left voice channel', 'info');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function quickJumpToVoice(accountId) {
  switchTab('voice');
  setTimeout(() => {
    const card = document.getElementById(`voice-card-${accountId}`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.style.outline = '2px solid var(--accent-purple)';
      setTimeout(() => card.style.outline = 'none', 1500);
    }
  }, 100);
}

// --- MUSIC PLAYER DECK ---
function populateMusicBotSelect() {
  const botSelect = document.getElementById('music-bot-select');
  if (!botSelect) return;

  const onlineBots = state.accounts.filter(a => a.status === 'online');
  botSelect.innerHTML = '<option value="">-- Choose Account --</option>';

  onlineBots.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = `${b.label} (${b.user?.tag || b.id})`;
    if (b.id === state.selectedMusicBotId) opt.selected = true;
    botSelect.appendChild(opt);
  });

  if (!state.selectedMusicBotId && onlineBots.length > 0) {
    state.selectedMusicBotId = onlineBots[0].id;
    botSelect.value = onlineBots[0].id;
    handleMusicBotChange();
  }
}

document.getElementById('music-bot-select')?.addEventListener('change', (e) => {
  state.selectedMusicBotId = e.target.value;
  handleMusicBotChange();
});

async function handleMusicBotChange() {
  if (!state.selectedMusicBotId) return;

  const guildSelect = document.getElementById('music-guild-select');
  const voiceSelect = document.getElementById('music-voice-select');
  guildSelect.innerHTML = '<option value="">Loading servers...</option>';
  voiceSelect.innerHTML = '<option value="">-- Choose Voice Channel --</option>';

  try {
    const res = await fetch(`/api/accounts/${state.selectedMusicBotId}/guilds`);
    const data = await res.json();
    if (!data.success) return;

    guildSelect.innerHTML = '<option value="">-- Choose Server --</option>';
    data.guilds.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = g.name;
      guildSelect.appendChild(opt);
    });

    guildSelect._cachedGuilds = data.guilds;

    // Check if bot already in a guild
    const bot = state.accounts.find(a => a.id === state.selectedMusicBotId);
    if (bot?.currentVoice?.guildId) {
      guildSelect.value = bot.currentVoice.guildId;
      state.selectedGuildId = bot.currentVoice.guildId;
      handleMusicGuildChange();
      loadActivePlayer();
    }
  } catch (e) {
    console.error('Error fetching bot guilds:', e);
  }
}

document.getElementById('music-guild-select')?.addEventListener('change', (e) => {
  state.selectedGuildId = e.target.value;
  handleMusicGuildChange();
  loadActivePlayer();
});

function handleMusicGuildChange() {
  const guildSelect = document.getElementById('music-guild-select');
  const voiceSelect = document.getElementById('music-voice-select');
  if (!guildSelect._cachedGuilds || !guildSelect.value) return;

  const guild = guildSelect._cachedGuilds.find(g => g.id === guildSelect.value);
  voiceSelect.innerHTML = '<option value="">-- Choose Voice Channel --</option>';

  if (guild) {
    const bot = state.accounts.find(a => a.id === state.selectedMusicBotId);
    const activeChanId = bot?.currentVoice?.channelId;

    guild.voiceChannels.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = `🔊 ${ch.name}`;
      if (ch.id === activeChanId) opt.selected = true;
      voiceSelect.appendChild(opt);
    });
  }
}

document.getElementById('btn-connect-music-voice')?.addEventListener('click', async () => {
  const voiceSelect = document.getElementById('music-voice-select');
  const channelId = voiceSelect?.value;
  if (!state.selectedMusicBotId || !channelId) {
    return showToast('Select an account and voice channel first!', 'warn');
  }

  try {
    showToast('Connecting bot to voice channel...', 'info');
    const res = await fetch(`/api/accounts/${state.selectedMusicBotId}/voice/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Bot connected to Voice for Music!', 'success');
      loadActivePlayer();
    } else {
      showToast(data.error || 'Failed to connect voice', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// Load Active Player for selected guild
async function loadActivePlayer() {
  if (!state.selectedGuildId) return;

  try {
    const res = await fetch(`/api/music/player/${state.selectedGuildId}`);
    const data = await res.json();
    if (data.success && data.player) {
      updateNowPlayingUI(data.player);
      renderQueue(data.player);
    } else {
      resetPlayerUI();
    }
  } catch (e) {
    console.error('Failed to load active player:', e);
  }
}

// Search & Play Music
document.getElementById('btn-music-search')?.addEventListener('click', executeMusicSearch);
document.getElementById('music-search-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') executeMusicSearch();
});

async function executeMusicSearch() {
  const input = document.getElementById('music-search-input');
  const query = input?.value?.trim();
  if (!query) return;

  if (!state.selectedGuildId) {
    return showToast('Please select a target Server & Voice Channel first!', 'warn');
  }

  showToast('Searching for music...', 'info');
  try {
    const res = await fetch(`/api/music/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!data.success || !data.result.tracks || data.result.tracks.length === 0) {
      return showToast('No tracks found for that search', 'warn');
    }

    // If query was direct link, play directly
    if (/^https?:\/\//i.test(query)) {
      if (data.result.loadType === 'playlist') {
        await addPlaylistToQueue(data.result.tracks);
      } else {
        await playTrackDirect(data.result.tracks[0]);
      }
      input.value = '';
      return;
    }

    // Render search results dropdown
    renderSearchResults(data.result.tracks);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderSearchResults(tracks) {
  const box = document.getElementById('search-results-box');
  const list = document.getElementById('search-results-list');
  box.style.display = 'block';
  list.innerHTML = '';

  tracks.slice(0, 8).forEach(t => {
    const item = document.createElement('div');
    item.className = 'search-item';
    item.innerHTML = `
      <img class="search-thumb" src="${t.info.artworkUrl || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=100'}" alt="Cover">
      <div class="search-info">
        <div class="search-title">${escapeHTML(t.info.title)}</div>
        <div class="search-author">${escapeHTML(t.info.author)} • ${formatDuration(t.info.length)}</div>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-sm btn-primary" onclick="playSearchTrack('${encodeURIComponent(JSON.stringify(t))}')">
          <i class="fa-solid fa-play"></i> Play
        </button>
      </div>
    `;
    list.appendChild(item);
  });
}

function closeSearchResults() {
  document.getElementById('search-results-box').style.display = 'none';
}

async function playSearchTrack(encodedTrackStr) {
  const track = JSON.parse(decodeURIComponent(encodedTrackStr));
  closeSearchResults();
  document.getElementById('music-search-input').value = '';
  await playTrackDirect(track);
}

async function playTrackDirect(track) {
  if (!state.selectedGuildId) {
    return showToast('Please select a target Server & Voice Channel first!', 'warn');
  }

  try {
    const channelId = document.getElementById('music-voice-select')?.value;
    const res = await fetch(`/api/music/player/${state.selectedGuildId}/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        track,
        accountId: state.selectedMusicBotId,
        channelId
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.result.status === 'playing' ? `Now playing: ${track.info.title}` : `Added to queue: ${track.info.title}`, 'success');
      loadActivePlayer();
    } else {
      showToast(data.error || 'Failed to play track', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function addPlaylistToQueue(tracks) {
  if (!state.selectedGuildId) {
    return showToast('Please select a target Server & Voice Channel first!', 'warn');
  }

  try {
    const channelId = document.getElementById('music-voice-select')?.value;
    const res = await fetch(`/api/music/player/${state.selectedGuildId}/playlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tracks,
        accountId: state.selectedMusicBotId,
        channelId
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Added ${data.count} songs from playlist to queue!`, 'success');
      loadActivePlayer();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Play / Pause
document.getElementById('btn-play-pause')?.addEventListener('click', async () => {
  if (!state.selectedGuildId || !state.activePlayer) return;

  const isPaused = state.activePlayer.paused;
  try {
    await fetch(`/api/music/player/${state.selectedGuildId}/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: !isPaused })
    });
    state.activePlayer.paused = !isPaused;
    updatePlayPauseButton();
  } catch (e) {}
});

// Skip
document.getElementById('btn-skip')?.addEventListener('click', async () => {
  if (!state.selectedGuildId) return;
  try {
    await fetch(`/api/music/player/${state.selectedGuildId}/skip`, { method: 'POST' });
    showToast('Skipped to next track', 'info');
  } catch (e) {}
});

// Stop
document.getElementById('btn-stop-track')?.addEventListener('click', async () => {
  if (!state.selectedGuildId) return;
  try {
    await fetch(`/api/music/player/${state.selectedGuildId}/stop`, { method: 'POST' });
    resetPlayerUI();
    showToast('Playback stopped & queue cleared', 'info');
  } catch (e) {}
});

// Loop
document.getElementById('btn-loop-mode')?.addEventListener('click', async () => {
  if (!state.selectedGuildId || !state.activePlayer) return;

  const modes = ['off', 'track', 'queue'];
  const currentIdx = modes.indexOf(state.activePlayer.loop || 'off');
  const nextMode = modes[(currentIdx + 1) % modes.length];

  try {
    await fetch(`/api/music/player/${state.selectedGuildId}/loop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: nextMode })
    });
    state.activePlayer.loop = nextMode;
    document.getElementById('loop-mode-text').textContent = nextMode.toUpperCase();
    showToast(`Loop Mode: ${nextMode.toUpperCase()}`, 'info');
  } catch (e) {}
});

// Volume Slider
async function setMusicVolume(val) {
  if (!state.selectedGuildId) return showToast('Select a bot & server first!', 'warn');
  const num = parseInt(val, 10);
  const slider = document.getElementById('volume-slider');
  if (slider) slider.value = num;
  try {
    await fetch(`/api/music/player/${state.selectedGuildId}/volume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: num })
    });
    showToast(`Volume set to ${num}%`, 'info');
  } catch (e) {}
}

document.getElementById('volume-slider')?.addEventListener('change', async (e) => {
  await setMusicVolume(e.target.value);
});

// Audio Filters
document.querySelectorAll('.filter-pill').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (!state.selectedGuildId) return showToast('Join a server and voice channel first!', 'warn');

    const filterName = btn.dataset.filter;
    const isActive = btn.classList.contains('active');
    const newState = !isActive;

    try {
      await fetch(`/api/music/player/${state.selectedGuildId}/filter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filterName, enabled: newState })
      });
      btn.classList.toggle('active', newState);
      if (filterName === 'extremeLoud') {
        showToast(`Extreme Loud ${newState ? 'Enabled (Bass Cut & High Definition)' : 'Disabled'}`, 'info');
      } else if (filterName === 'packing') {
        showToast(`Packing Boost ${newState ? 'Enabled' : 'Disabled'}`, 'info');
      } else if (filterName === 'clarity') {
        showToast(`Crystal Clarity ${newState ? 'Enabled (Bass Removed)' : 'Disabled'}`, 'info');
      } else {
        showToast(`${filterName.toUpperCase()} filter ${newState ? 'enabled' : 'disabled'}!`, 'info');
      }
    } catch (e) {}
  });
});

function updatePlayerUI(player) {
  if (!player) return;
  state.activePlayer = player;
  if (player.volume !== undefined) {
    const slider = document.getElementById('volume-slider');
    if (slider) slider.value = player.volume;
  }
  if (player.filters) {
    document.querySelectorAll('.filter-pill').forEach(btn => {
      const fName = btn.dataset.filter;
      if (fName && player.filters[fName] !== undefined) {
        btn.classList.toggle('active', !!player.filters[fName]);
      }
    });
  }
  if (player.currentTrack) {
    updateNowPlayingUI(player);
  }
}

// Seekbar Click-to-seek
document.getElementById('seekbar-track')?.addEventListener('click', async (e) => {
  if (!state.selectedGuildId || !state.activePlayer?.currentTrack) return;

  const rect = e.currentTarget.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const percentage = Math.max(0, Math.min(1, clickX / rect.width));

  const targetMs = Math.floor(percentage * state.currentTrackDuration);

  try {
    await fetch(`/api/music/player/${state.selectedGuildId}/seek`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: targetMs })
    });
    state.currentTrackPosition = targetMs;
    updateSeekbarVisual();
  } catch (e) {}
});

// Clear Queue
document.getElementById('btn-clear-queue')?.addEventListener('click', async () => {
  if (!state.selectedGuildId) return;
  try {
    await fetch(`/api/music/player/${state.selectedGuildId}/queue`, { method: 'DELETE' });
    renderQueue({ queue: [] });
    showToast('Queue cleared', 'info');
  } catch (e) {}
});

// Update Now Playing UI
function updateNowPlayingUI(player) {
  state.activePlayer = player;
  const track = player.currentTrack;

  const titleEl = document.getElementById('now-playing-title');
  const authorEl = document.getElementById('now-playing-author');
  const artEl = document.getElementById('now-playing-art');
  const dot = document.getElementById('music-playing-dot');
  const visualizer = document.getElementById('playing-visualizer');
  const loopTxt = document.getElementById('loop-mode-text');

  if (track) {
    titleEl.textContent = track.info.title;
    authorEl.textContent = track.info.author;
    artEl.src = track.info.artworkUrl || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=400';
    state.currentTrackDuration = track.info.length || 0;
    state.currentTrackPosition = player.position || 0;
    document.getElementById('time-total').textContent = formatDuration(state.currentTrackDuration);
    dot.style.display = 'block';
    visualizer.style.display = player.paused ? 'none' : 'flex';
  } else {
    resetPlayerUI();
  }

  if (loopTxt && player.loop) {
    loopTxt.textContent = player.loop.toUpperCase();
  }

  updatePlayPauseButton();
  updateSeekbarVisual();
  startSeekTimer();
  renderStats();
}

function updatePlayPauseButton() {
  const icon = document.getElementById('icon-play-pause');
  const visualizer = document.getElementById('playing-visualizer');

  if (state.activePlayer && state.activePlayer.playing && !state.activePlayer.paused) {
    icon.className = 'fa-solid fa-pause';
    if (visualizer) visualizer.style.display = 'flex';
  } else {
    icon.className = 'fa-solid fa-play';
    if (visualizer) visualizer.style.display = 'none';
  }
}

function resetPlayerUI() {
  document.getElementById('now-playing-title').textContent = 'No Track Playing';
  document.getElementById('now-playing-author').textContent = 'Select a track or search above';
  document.getElementById('now-playing-art').src = 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=400';
  document.getElementById('time-current').textContent = '0:00';
  document.getElementById('time-total').textContent = '0:00';
  document.getElementById('seekbar-fill').style.width = '0%';
  document.getElementById('music-playing-dot').style.display = 'none';
  document.getElementById('playing-visualizer').style.display = 'none';
  document.getElementById('icon-play-pause').className = 'fa-solid fa-play';

  if (state.positionInterval) {
    clearInterval(state.positionInterval);
    state.positionInterval = null;
  }
  renderStats();
}

function startSeekTimer() {
  if (state.positionInterval) clearInterval(state.positionInterval);

  state.positionInterval = setInterval(() => {
    if (state.activePlayer && state.activePlayer.playing && !state.activePlayer.paused) {
      state.currentTrackPosition += 1000;
      if (state.currentTrackPosition > state.currentTrackDuration) {
        state.currentTrackPosition = state.currentTrackDuration;
      }
      updateSeekbarVisual();
    }
  }, 1000);
}

function updateSeekbarVisual() {
  const fill = document.getElementById('seekbar-fill');
  const currLabel = document.getElementById('time-current');

  if (state.currentTrackDuration > 0) {
    const pct = Math.min(100, (state.currentTrackPosition / state.currentTrackDuration) * 100);
    fill.style.width = `${pct}%`;
  } else {
    fill.style.width = '0%';
  }
  currLabel.textContent = formatDuration(state.currentTrackPosition);
}

// Render Queue
function renderQueue(player) {
  const container = document.getElementById('queue-items-container');
  const countEl = document.getElementById('queue-count');
  const queue = player.queue || [];

  countEl.textContent = queue.length;
  if (queue.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-music"></i>
        <p>Queue is currently empty</p>
      </div>`;
    return;
  }

  container.innerHTML = '';
  queue.forEach((t, idx) => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    item.innerHTML = `
      <span class="queue-index font-mono">${idx + 1}</span>
      <div class="queue-info">
        <div class="queue-title">${escapeHTML(t.info.title)}</div>
        <div class="queue-author">${escapeHTML(t.info.author)}</div>
      </div>
      <span class="queue-duration font-mono">${formatDuration(t.info.length)}</span>
      <button class="queue-remove" onclick="removeQueueItem(${idx})"><i class="fa-solid fa-xmark"></i></button>
    `;
    container.appendChild(item);
  });
}

async function removeQueueItem(index) {
  if (!state.selectedGuildId) return;
  try {
    await fetch(`/api/music/player/${state.selectedGuildId}/queue/${index}`, { method: 'DELETE' });
    showToast('Removed from queue', 'info');
  } catch (e) {}
}

// --- ACCOUNTS ACTIONS ---
function openAddAccountModal() {
  document.getElementById('modal-add-account').classList.add('active');
  document.getElementById('add-account-error').style.display = 'none';
  document.getElementById('add-bot-token').value = '';

  const limit = state.botLimit || state.currentUser?.botLimit || 10;
  const currentCount = state.accounts.length;
  const quotaText = document.getElementById('modal-quota-text');
  const quotaBanner = document.getElementById('modal-quota-banner');
  const btn = document.getElementById('btn-submit-add-account');

  if (quotaText) {
    if (currentCount >= limit) {
      quotaText.textContent = `${currentCount} / ${limit} (QUOTA FULL)`;
      quotaText.style.color = '#ef4444';
      if (quotaBanner) {
        quotaBanner.style.background = 'rgba(239, 68, 68, 0.15)';
        quotaBanner.style.borderColor = 'rgba(239, 68, 68, 0.4)';
      }
      if (btn) btn.disabled = true;
    } else {
      quotaText.textContent = `${currentCount} / ${limit} Bots Used`;
      quotaText.style.color = '#c084fc';
      if (quotaBanner) {
        quotaBanner.style.background = 'rgba(168, 85, 247, 0.12)';
        quotaBanner.style.borderColor = 'rgba(168, 85, 247, 0.35)';
      }
      if (btn) btn.disabled = false;
    }
  }
}

function closeAddAccountModal() {
  document.getElementById('modal-add-account').classList.remove('active');
}

document.getElementById('btn-open-add-bot')?.addEventListener('click', openAddAccountModal);

function toggleTokenVisibility() {
  const input = document.getElementById('add-bot-token');
  const icon = document.getElementById('eye-icon');
  if (input.type === 'password') {
    input.type = 'text';
    icon.className = 'fa-solid fa-eye-slash';
  } else {
    input.type = 'password';
    icon.className = 'fa-solid fa-eye';
  }
}

async function submitAddAccount() {
  const token = document.getElementById('add-bot-token').value.trim();
  const label = document.getElementById('add-bot-label').value.trim() || 'Selfbot Account';
  const autoStart = document.getElementById('add-bot-autostart').checked;
  const errBox = document.getElementById('add-account-error');
  const btn = document.getElementById('btn-submit-add-account');

  const limit = state.botLimit || state.currentUser?.botLimit || 10;
  if (state.accounts.length >= limit) {
    errBox.textContent = `Bot account limit reached (${state.accounts.length}/${limit} bots). Your credentials only allow up to ${limit} bots. Please contact administrator to increase your limit.`;
    errBox.style.display = 'block';
    return;
  }

  if (!token) {
    errBox.textContent = 'Token cannot be empty!';
    errBox.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Validating & Connecting...';

  try {
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, label, autoStart })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Account "${label}" added successfully!`, 'success');
      closeAddAccountModal();
      // Reload accounts
      fetchAccounts();
    } else {
      errBox.textContent = data.error || 'Failed to add account';
      errBox.style.display = 'block';
    }
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-plus"></i> Connect Account';
  }
}

async function fetchAccounts() {
  try {
    const res = await fetch('/api/accounts');
    const data = await res.json();
    if (data.success) {
      state.accounts = data.accounts;
      renderAllAccounts();
      renderVoiceManagerCards();
      renderStats();
      populateMusicBotSelect();
    }
  } catch (e) {}
}

async function startAccount(id) {
  try {
    showToast('Starting account...', 'info');
    const res = await fetch(`/api/accounts/${id}/start`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Account started!', 'success');
    } else {
      showToast(data.error || 'Failed to start', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function stopAccount(id) {
  try {
    showToast('Stopping account...', 'info');
    const res = await fetch(`/api/accounts/${id}/stop`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Account stopped', 'info');
    }
  } catch (e) {}
}

async function deleteAccount(id) {
  if (!confirm('Are you sure you want to remove this account from the dashboard?')) return;

  try {
    const res = await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('Account removed', 'info');
      state.accounts = state.accounts.filter(a => a.id !== id);
      renderAllAccounts();
      renderVoiceManagerCards();
      renderStats();
    }
  } catch (e) {}
}

document.getElementById('btn-start-all')?.addEventListener('click', async () => {
  showToast('Starting all accounts...', 'info');
  await fetch('/api/accounts/start-all', { method: 'POST' });
});

document.getElementById('btn-stop-all')?.addEventListener('click', async () => {
  showToast('Stopping all accounts...', 'info');
  await fetch('/api/accounts/stop-all', { method: 'POST' });
});

// --- PRESENCE CUSTOMIZATION MODAL ---
function openPresenceModal(accountId) {
  const acc = state.accounts.find(a => a.id === accountId);
  if (!acc) return;

  document.getElementById('presence-account-id').value = accountId;
  document.getElementById('presence-status-select').value = acc.presence?.status || 'online';
  document.getElementById('presence-activity-type').value = acc.presence?.activity?.type || 'PLAYING';
  document.getElementById('presence-activity-name').value = acc.presence?.activity?.name || '';
  document.getElementById('modal-edit-presence').classList.add('active');
}

function closePresenceModal() {
  document.getElementById('modal-edit-presence').classList.remove('active');
}

async function submitPresence() {
  const accountId = document.getElementById('presence-account-id').value;
  const status = document.getElementById('presence-status-select').value;
  const type = document.getElementById('presence-activity-type').value;
  const name = document.getElementById('presence-activity-name').value.trim();

  try {
    const res = await fetch(`/api/accounts/${accountId}/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        activity: name ? { type, name } : null
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Presence & status updated!', 'success');
      closePresenceModal();
      const acc = state.accounts.find(a => a.id === accountId);
      if (acc) {
        acc.presence = { status, activity: name ? { type, name } : null };
        updateAccountCard(acc);
      }
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --- LIVE LOGS TERMINAL ---
function appendLogEntry(entry) {
  const terminal = document.getElementById('terminal-stream');
  const preview = document.getElementById('overview-logs-preview');

  // Check filter
  if (state.logFilter !== 'ALL') {
    if (state.logFilter === 'ERROR' && entry.level !== 'ERROR') return;
    if (state.logFilter !== 'ERROR' && entry.tag !== state.logFilter) return;
  }

  const timeStr = entry.timestamp.substring(11, 19);
  const rowHtml = `
    <div class="log-line">
      <span class="log-time">[${timeStr}]</span>
      <span class="log-tag ${entry.level}">[${escapeHTML(entry.tag)}]</span>
      <span class="log-msg">${escapeHTML(entry.message)}</span>
    </div>
  `;

  if (terminal) {
    terminal.insertAdjacentHTML('beforeend', rowHtml);
    if (state.autoScroll) {
      terminal.scrollTop = terminal.scrollHeight;
    }
  }

  if (preview) {
    preview.insertAdjacentHTML('beforeend', rowHtml);
    preview.scrollTop = preview.scrollHeight;
  }
}

document.querySelectorAll('.btn-filter').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.logFilter = btn.dataset.filter;
    // Reload logs
    fetchLogs();
  });
});

async function fetchLogs() {
  try {
    const terminal = document.getElementById('terminal-stream');
    if (!terminal) return;
    const res = await fetch('/api/logs');
    const data = await res.json();
    if (data.success) {
      terminal.innerHTML = '';
      data.logs.forEach(appendLogEntry);
    }
  } catch (e) {}
}

document.getElementById('btn-clear-logs')?.addEventListener('click', async () => {
  await fetch('/api/logs/clear', { method: 'POST' });
});

document.getElementById('autoscroll-toggle')?.addEventListener('change', (e) => {
  state.autoScroll = e.target.checked;
});

// --- SETTINGS FORM ---
document.getElementById('form-lavalink-config')?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = document.getElementById('cfg-node-name').value.trim();
  const url = document.getElementById('cfg-node-url').value.trim();
  const auth = document.getElementById('cfg-node-auth').value.trim();
  const secure = document.getElementById('cfg-node-secure').checked;

  try {
    showToast('Updating Lavalink node configuration...', 'info');
    const res = await fetch('/api/lavalink/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, auth, secure })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Lavalink config saved & reconnecting!', 'success');
    } else {
      showToast(data.error || 'Failed to save config', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// --- HELPER FUNCTIONS ---
function formatDuration(ms) {
  if (!ms || isNaN(ms)) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = {
    info: 'fa-circle-info',
    success: 'fa-circle-check',
    error: 'fa-circle-exclamation',
    warn: 'fa-triangle-exclamation'
  };

  toast.innerHTML = `
    <i class="fa-solid ${icons[type] || 'fa-bell'}"></i>
    <span>${escapeHTML(message)}</span>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(50px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
  checkUserAuth();
});
