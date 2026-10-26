const path = require('path');
require('dotenv').config();

function parseBoolean(val) {
  if (typeof val === 'boolean') return val;
  if (!val) return false;
  return ['true', '1', 'yes', 'on'].includes(String(val).toLowerCase().trim());
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.join(__dirname, '..', 'data'),
  accountsFile: path.join(__dirname, '..', 'data', 'accounts.json'),
  settingsFile: path.join(__dirname, '..', 'data', 'settings.json'),
  uploadsFile: path.join(__dirname, '..', 'data', 'uploaded_songs.json'),
  
  // Default Discord Proxy for cloud datacenter hosting
  defaultProxy: process.env.DISCORD_PROXY || "http://pldkrffl:sqqoj1cw6sxr@45.38.107.97:6014",

  // Default Lavalink Node
  defaultNode: {
    url: process.env.NODE_URL || "noi6.visihost.in:25591",
    name: process.env.NODE_NAME || "Lava Lenin",
    auth: process.env.NODE_AUTH || "ganahubkl",
    secure: parseBoolean(process.env.NODE_SECURE || "false"),
  },
  
  parseBoolean
};
