const git = require('isomorphic-git');
const fs = require('fs');
const path = require('path');

const dir = __dirname;

async function commitAll() {
  try {
    const status = await git.statusMatrix({ fs, dir });
    const changed = status.filter(r => r[2] !== r[3] || r[1] !== r[2]);
    console.log('Modified files:');
    for (const file of changed) {
      console.log(' - ' + file[0]);
      if (file[2] === 0) {
        await git.remove({ fs, dir, filepath: file[0] });
      } else {
        await git.add({ fs, dir, filepath: file[0] });
      }
    }

    if (changed.length === 0) {
      console.log('No changes to commit.');
      return;
    }

    const sha = await git.commit({
      fs,
      dir,
      message: 'Isolate music playback and WebSocket events per credential user',
      author: {
        name: 'speedy18ee',
        email: 'speedy@example.com'
      }
    });

    console.log('Committed successfully. SHA:', sha);
  } catch (err) {
    console.error('Commit error:', err);
  }
}

commitAll();
