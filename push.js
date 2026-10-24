const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const token = process.argv[2] || process.env.GITHUB_TOKEN;

if (!token) {
  console.log('---------------------------------------------------------');
  console.log('GitHub Personal Access Token (PAT) Required!');
  console.log('Usage: node push.js <YOUR_GITHUB_TOKEN>');
  console.log('');
  console.log('To get a token:');
  console.log('1. Go to https://github.com/settings/tokens');
  console.log('2. Click "Generate new token (classic)"');
  console.log('3. Check the "repo" scope');
  console.log('4. Copy the token (starts with ghp_...)');
  console.log('---------------------------------------------------------');
  process.exit(1);
}

async function run() {
  console.log('Connecting to GitHub repository speedy18ee/speedy...');
  try {
    const result = await git.push({
      fs,
      http,
      dir,
      remote: 'origin',
      ref: 'main',
      force: true,
      onAuth: () => ({ username: token })
    });
    console.log('SUCCESS! Code pushed successfully to https://github.com/speedy18ee/speedy');
    console.log('You can now connect the repo to Render (https://render.com) for 1-click deployment.');
  } catch (err) {
    console.error('Push error:', err.message);
  }
}

run();
