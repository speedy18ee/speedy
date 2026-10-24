const mod = require('https-proxy-agent');
console.log('mod is function/class?', typeof mod);
console.log('mod.HttpsProxyAgent is?', typeof mod.HttpsProxyAgent);
try {
  const agent = new mod.HttpsProxyAgent('http://pldkrffl:sqqoj1cw6sxr@45.38.107.97:6014');
  console.log('Agent created successfully:', agent.constructor.name);
} catch (e) {
  console.error('Error creating agent:', e);
}
