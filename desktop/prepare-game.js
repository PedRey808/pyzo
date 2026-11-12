// Copies the game (monopoly/index.html + PeerJS) into desktop/game before start/build.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'monopoly');
const dst = path.join(__dirname, 'game');
fs.mkdirSync(dst, {recursive: true});
for (const f of ['index.html', 'peerjs.min.js']) fs.copyFileSync(path.join(src, f), path.join(dst, f));
console.log('Игра скопирована в desktop/game');
