const fs = require('fs');
const path = require('path');

// Permanently patch ClientUserSettingManager.js on disk if unpatched
try {
  const filePath = path.join(__dirname, '..', 'node_modules', 'discord.js-selfbot-v13', 'src', 'managers', 'ClientUserSettingManager.js');
  if (fs.existsSync(filePath)) {
    let code = fs.readFileSync(filePath, 'utf8');
    const buggyTarget = "if ('friend_source_flags' in data) {";
    const fixedReplacement = "if ('friend_source_flags' in data && data.friend_source_flags) {";
    
    if (code.includes(buggyTarget)) {
      code = code.replace(buggyTarget, fixedReplacement);
      fs.writeFileSync(filePath, code, 'utf8');
    }
  }
} catch (err) {}

module.exports = true;
