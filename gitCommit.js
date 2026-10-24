const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const fs = require('fs');
const path = require('path');

const dir = 'C:\\Users\\pradyumna\\Downloads\\web soket';

async function main() {
  // Check if .git exists, if not init
  const gitDir = path.join(dir, '.git');
  if (!fs.existsSync(gitDir)) {
    console.log('Initializing git repository...');
    await git.init({ fs, dir });
  } else {
    console.log('Git repo already initialized.');
  }

  // Set remote
  const remotes = await git.listRemotes({ fs, dir });
  const hasOrigin = remotes.some(r => r.remote === 'origin');
  if (!hasOrigin) {
    console.log('Adding remote origin...');
    await git.addRemote({
      fs,
      dir,
      remote: 'origin',
      url: 'https://github.com/speedy18ee/speedy.git'
    });
  } else {
    console.log('Remote origin already set.');
  }

  // Add files according to .gitignore
  console.log('Staging files...');
  // We can scan files
  const globby = async (base, current = '') => {
    const full = path.join(base, current);
    const entries = fs.readdirSync(full, { withFileTypes: true });
    let files = [];
    for (const ent of entries) {
      const rel = current ? `${current}/${ent.name}` : ent.name;
      if (rel.startsWith('.git') || rel.startsWith('node_modules')) continue;
      if (ent.isDirectory()) {
        files = files.concat(await globby(base, rel));
      } else {
        files.push(rel);
      }
    }
    return files;
  };

  const files = await globby(dir);
  for (const file of files) {
    // Check if ignored
    const ignored = await git.isIgnored({ fs, dir, filepath: file });
    if (!ignored) {
      await git.add({ fs, dir, filepath: file });
    }
  }

  console.log('Committing changes...');
  const sha = await git.commit({
    fs,
    dir,
    author: {
      name: 'speedy18ee',
      email: 'speedy18ee@users.noreply.github.com'
    },
    message: 'Deploy EXC Selfbot Multi-Account Dashboard to Render'
  });
  console.log('Committed:', sha);
}

main().catch(err => console.error('Error:', err));
