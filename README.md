# 🎵 Discord Selfbot Multi-Account 24/7 & Lavalink Music Dashboard

A Discord Selfbot Management Suite and Web Dashboard featuring **Multi-Account Support**, **Lavalink v4 Audio Streaming**, and **24/7 Voice Channel Stay** with auto-reconnection.

---

## ✨ Features

- **🌐 Web-Based Token Management (No `.env` required for tokens)**:
  - Add, test, and manage unlimited Discord selfbot accounts directly from the Web UI.
  - Set custom nicknames/labels for accounts (e.g. *Main Account*, *24/7 VC Bot*, *Lofi Bot*).
  - Secure local persistence in `data/accounts.json` across server restarts.
  - Per-account controls: Start, Stop, Delete, Status Changer (Online / Idle / DND / Invisible), and Custom Rich Presence.
  - Global One-Click **Start All** and **Stop All**.

- **🎙️ 24/7 Voice Channel Stay**:
  - Connect any bot to any Voice or Stage Channel.
  - Interactive Server & Voice Channel selector loaded dynamically from Discord.
  - **24/7 Keep-Alive**: Automatically reconnects if kicked, moved, or disconnected.
  - Configurable **Self-Mute** and **Self-Deafen** options.
  - Persists across computer reboots and server restarts.

- **⚡ Lavalink v4 Audio Engine ("Lava Lenin")**:
  - Pre-configured with the requested Lavalink node:
    - **URL:** `noi6.visihost.in:25591`
    - **Name:** `Lava Lenin`
    - **Auth:** `ganahubkl`
    - **Secure:** `false`
  - High-fidelity streaming with YouTube, Spotify, SoundCloud, and direct stream links.
  - Interactive playback controls: Play, Pause, Resume, Skip, Stop, and Click-to-Seek progress bar.
  - Audio tweaks: Volume slider (0 - 300%), Bass Boost EQ, Nightcore, Vaporwave, and 8D audio.
  - Full Queue Management: view upcoming tracks, remove individual tracks, or clear queue.

- **💻 Premium Glassmorphic Cyber Dark UI**:
  - Discord Blurple `#5865F2` theme with glass blur effects and animated visualizer waves.
  - Live statistics: Active accounts, voice connections, Lavalink memory & CPU load, and ping latency.
  - Real-time streaming WebSocket console logs with tag filtering (Bots, Voice, Lavalink, Errors).

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
```

### 3. Open the Web Dashboard
Navigate to:
```
http://localhost:3000
```

---

## 📖 How to Add Accounts

1. Open `http://localhost:3000` in your browser.
2. Click the **"Add Account"** button in the top right header.
3. Paste your Discord user token and give it a nickname.
4. Click **"Connect Account"**. The bot will immediately log in and appear in your dashboard!
5. Head over to the **"24/7 Voice Stay"** tab to choose your server and voice channel, then flip the **24/7 Keep-Alive** switch.

---

## 🛡️ Architecture

```
├── server.js               # Express Server & WebSocket broadcaster
├── src/
│   ├── config.js           # Configuration loader
│   ├── database.js         # JSON persistent storage
│   ├── logger.js           # Centralized in-memory & broadcast logger
│   ├── botManager.js       # Multi-account selfbot controller & 24/7 watchdog
│   └── lavalinkClient.js   # Lavalink v4 WebSocket & REST audio player
├── public/
│   ├── index.html          # Single-Page Application UI
│   ├── css/style.css       # Premium dark glassmorphic styling
│   └── js/app.js           # Frontend reactive controller & WebSockets
└── data/                   # Persistent local storage for accounts & settings
```
