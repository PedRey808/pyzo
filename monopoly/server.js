#!/usr/bin/env node
// Магнат: игровой сервер без зависимостей (Node.js 14+). Подходит для Termux на Android.
// Запуск: node server.js        (порт по умолчанию 8080, можно PORT=3000 node server.js)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const dgram = require('dgram');
const EventEmitter = require('events');

const PORT = +process.env.PORT || 8080;
const HTML_PATH = path.join(__dirname, 'index.html');
const SAVE_PATH = path.join(__dirname, 'magnat-rooms.json');
const COLORS = ['#e53935', '#1e88e5', '#43a047', '#fbc02d', '#8e24aa', '#fb8c00', '#00acc1', '#ec407a'];
const BOT_NAMES = ['Аркадий', 'Варвара', 'Геннадий', 'Зоя', 'Лев', 'Марта', 'Остап', 'Фёдор'];

// ---------- game logic is shared with the browser: take it from index.html ----------
function loadPage() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/<script id="logic">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('В index.html не найден блок игровой логики');
  const mod = {exports:{}};
  new Function('module', m[1])(mod);
  return {html:html.replace('</head>', '<script>window.MAGNAT_SERVER=1</script>\n</head>'), logic:mod.exports};
}
const PAGE = loadPage();
const {Game, GErr, botAct, botTrade, botAuction, START} = PAGE.logic;

// ---------- minimal WebSocket (RFC 6455) ----------
class WS extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock; this.buf = Buffer.alloc(0); this.open = true; this.frag = null; this.alive = true;
    sock.setNoDelay(true);
    sock.on('data', d => this.onData(d));
    sock.on('close', () => this.closed());
    sock.on('error', () => this.closed());
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1], fin = b0 & 0x80, op = b0 & 0x0f, masked = b1 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) return this.close();
      const mOff = off; if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let p = Buffer.from(this.buf.subarray(off, off + len));
      if (masked) { const mk = this.buf.subarray(mOff, mOff + 4); for (let i = 0; i < p.length; i++) p[i] ^= mk[i & 3]; }
      this.buf = this.buf.subarray(off + len);
      this.alive = true;
      if (op === 0x8) return this.close();
      if (op === 0x9) { this.frame(0xA, p); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2) { if (fin) this.msg(p); else this.frag = [p]; }
      else if (op === 0 && this.frag) { this.frag.push(p); if (fin) { const all = Buffer.concat(this.frag); this.frag = null; this.msg(all); } }
    }
  }
  msg(p) { let m; try { m = JSON.parse(p.toString('utf8')); } catch (e) { return; } if (m && typeof m === 'object') this.emit('message', m); }
  frame(op, data) {
    if (!this.open) return;
    const n = data.length; let h;
    if (n < 126) h = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    try { this.sock.write(Buffer.concat([h, data])); } catch (e) {}
  }
  send(obj) { this.frame(0x1, Buffer.from(JSON.stringify(obj))); }
  close() { if (!this.open) return; this.frame(0x8, Buffer.alloc(0)); this.open = false; try { this.sock.end(); } catch (e) {} setTimeout(() => this.closed(), 1000); }
  closed() { if (this.done) return; this.done = true; this.open = false; try { this.sock.destroy(); } catch (e) {} this.emit('close'); }
}

// ---------- rooms ----------
const rooms = new Map();
const rnd = (n = 12) => crypto.randomBytes(n).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, n);
function genCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s; do { s = ''; for (let i = 0; i < 5; i++) s += A[crypto.randomInt(A.length)]; } while (rooms.has(s)); return s; }
const cleanName = n => { n = String(n || '').trim().slice(0, 16); return n || 'Игрок'; };
const mem = (r, pid) => r.members.find(m => m.pid === pid);
const freeColor = r => COLORS.find(c => !r.members.some(m => m.color === c)) || '#999';

function makeView(r) {
  return {
    room:{code:r.code, host:r.host, money:r.money, offline:false,
      members:r.members.map(m => ({pid:m.pid, name:m.name, color:m.color, bot:m.bot, connected:!!m.connected, left:!!m.left}))},
    chat:r.chat,
    game:r.game ? r.game.pub() : null,
  };
}
function sync(r) {
  r.touched = Date.now();
  const msg = {t:'state', s:makeView(r)};
  for (const ws of r.socks.values()) if (ws.open) ws.send(msg);
  scheduleSave();
}
function sysChat(r, t) { r.chat.push({id:rnd(6), n:'', c:'#888', t}); if (r.chat.length > 60) r.chat.shift(); }
function attach(r, m, ws) {
  const old = r.socks.get(m.pid);
  if (old && old !== ws) { old.pid = null; old.room = null; old.close(); }
  r.socks.set(m.pid, ws); ws.room = r; ws.pid = m.pid;
  m.connected = true; m.discAt = 0; m.left = false;
  ws.send({t:'welcome', pid:m.pid, code:r.code});
  sync(r);
}
function onMessage(ws, msg) {
  const t = msg.t;
  if (t === 'create') {
    const code = genCode();
    const m = {pid:'g' + rnd(6), name:cleanName(msg.name), color:COLORS[0], bot:false, token:String(msg.token || rnd()), connected:true};
    const r = {code, host:m.pid, members:[m], game:null, chat:[], money:START, lastAct:0, socks:new Map(), touched:Date.now()};
    rooms.set(code, r);
    log(`Комната ${code} создана (${m.name})`);
    return attach(r, m, ws);
  }
  if (t === 'join') {
    const r = rooms.get(String(msg.code || '').toUpperCase());
    if (!r) return ws.send({t:'err', msg:'Комната не найдена. Проверьте код', fatal:true});
    let m = msg.token && r.members.find(x => !x.bot && x.token === String(msg.token));
    if (!m) {
      if (r.game) return ws.send({t:'err', msg:'Игра уже началась', fatal:true});
      if (r.members.length >= 8) return ws.send({t:'err', msg:'Комната заполнена (максимум 8)', fatal:true});
      m = {pid:'g' + rnd(6), name:cleanName(msg.name), color:freeColor(r), bot:false, token:String(msg.token || rnd()), connected:true};
      r.members.push(m);
      sysChat(r, `${m.name} заходит в комнату`);
    }
    return attach(r, m, ws);
  }
  const r = ws.room, pid = ws.pid;
  if (!r || !pid) return;
  if (t === 'act') {
    if (!r.game) return ws.send({t:'err', msg:'Игра ещё не началась'});
    try { r.game.act(pid, String(msg.a), msg.d && typeof msg.d === 'object' ? msg.d : {}); r.lastAct = Date.now(); sync(r); }
    catch (e) { if (!(e instanceof GErr)) console.error(e); ws.send({t:'err', msg:e.message || 'Ошибка'}); }
  } else if (t === 'chat') {
    const text = String(msg.text || '').trim().slice(0, 200); if (!text) return;
    const m = mem(r, pid);
    r.chat.push({id:rnd(6), n:m.name, c:m.color, t:text}); if (r.chat.length > 60) r.chat.shift();
    sync(r);
  } else if (t === 'leave') {
    leaveRoom(r, pid);
  } else if (t === 'admin') {
    if (pid !== r.host) return ws.send({t:'err', msg:'Это может только создатель комнаты'});
    admin(r, msg);
  }
}
function admin(r, msg) {
  const op = msg.op;
  if (op === 'bot' && !r.game && r.members.length < 8) {
    const used = new Set(r.members.map(m => m.name));
    r.members.push({pid:'b' + rnd(6), name:'Бот ' + (BOT_NAMES.find(n => !used.has('Бот ' + n)) || rnd(2)), color:freeColor(r), bot:true, connected:true});
  } else if (op === 'kick' && !r.game && msg.pid !== r.host) {
    const ws = r.socks.get(msg.pid);
    if (ws) { ws.send({t:'kicked'}); r.socks.delete(msg.pid); ws.room = null; ws.pid = null; setTimeout(() => ws.close(), 300); }
    r.members = r.members.filter(m => m.pid !== msg.pid);
  } else if (op === 'money' && !r.game) {
    const v = +msg.money; if ([10000, 15000, 20000, 25000].includes(v)) r.money = v;
  } else if (op === 'start' && !r.game) {
    r.members = r.members.filter(m => m.bot || m.connected);
    if (r.members.length < 2) { const ws = r.socks.get(r.host); if (ws) ws.send({t:'err', msg:'Нужно минимум 2 игрока — добавьте бота или пригласите друзей'}); }
    else { r.game = new Game(r.members, {money:r.money}); r.lastAct = Date.now(); log(`Комната ${r.code}: игра началась (${r.members.length} игроков)`); }
  } else if (op === 'newgame' && r.game && r.game.phase === 'over') {
    r.game = null; r.members = r.members.filter(m => m.bot || m.connected);
  } else return;
  sync(r);
}
function leaveRoom(r, pid) {
  const m = mem(r, pid); if (!m) return;
  const ws = r.socks.get(pid);
  r.socks.delete(pid);
  if (ws) { ws.room = null; ws.pid = null; }
  if (!r.game) {
    r.members = r.members.filter(x => x !== m);
    sysChat(r, `${m.name} покидает комнату`);
  } else {
    m.left = true; m.connected = false;
    const p = r.game.P(pid);
    if (p && !p.out && r.game.phase !== 'over') { try { r.game.act(pid, 'surrender'); } catch (e) {} }
  }
  if (r.host === pid) { const next = r.members.find(x => !x.bot && !x.left && x.pid !== pid); if (next) r.host = next.pid; }
  if (!r.members.some(x => !x.bot && !x.left)) { rooms.delete(r.code); log(`Комната ${r.code} закрыта`); scheduleSave(); return; }
  sync(r);
}
function onClose(ws) {
  const r = ws.room; if (!r || r.socks.get(ws.pid) !== ws) return;
  r.socks.delete(ws.pid);
  const m = mem(r, ws.pid); if (m) { m.connected = false; m.discAt = Date.now(); }
  sync(r);
}

// bots, autopilot for players who lost connection, cleanup
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    const humansOnline = r.members.some(m => !m.bot && m.connected);
    if (!humansOnline && now - r.touched > (r.game ? 12 : 2) * 3600e3) { rooms.delete(r.code); scheduleSave(); continue; }
    const g = r.game; if (!g || g.phase === 'over' || !humansOnline) continue;
    if (g.phase === 'auction') {
      if (g.tick()) { sync(r); continue; }
      const ac = auctionAuto(g, r, now);
      if (ac) { try { g.act(ac[0], ac[1], ac[2]); } catch (e) {} sync(r); }
      continue;
    }
    let done = false;
    for (const t of g.trades) {
      const m = mem(r, t.to);
      if (m && m.bot && now - t.ts > 1500) {
        try { g.act(t.to, botTrade(g, t) ? 'accept' : 'reject', {id:t.id}); } catch (e) { g.trades = g.trades.filter(x => x !== t); }
        sync(r); done = true; break;
      }
    }
    if (done) continue;
    const cp = g.curP(), m = mem(r, cp.pid);
    const auto = !m || m.bot || m.left || (!m.connected && now - (m.discAt || 0) > 30000);
    if (!auto || now - r.lastAct < 850) continue;
    const ac = botAct(g, cp.pid, m && m.bot); if (!ac) continue;
    try { g.act(cp.pid, ac[0], ac[1] || {}); }
    catch (e) { try { g.act(cp.pid, g.phase === 'debt' ? 'bankrupt' : 'end'); } catch (e2) {} }
    r.lastAct = now; sync(r);
  }
}, 250);

function auctionAuto(g, r, now) {
  const a = g.auction;
  for (const p of g.alive()) {
    const m = mem(r, p.pid); if (!m) continue;
    const away = m.left || (!m.bot && !m.connected && now - (m.discAt || 0) > 30000);
    if (!m.bot && !away) continue;
    let h = 0; for (const ch of p.pid) h = (h * 31 + ch.charCodeAt(0)) % 997;
    if (now - a.at < 1200 + (h * 7 + a.seq * 13 + (a.bid / 10 | 0)) % 1600) continue;
    const ac = m.bot ? botAuction(g, p.pid) : (a.bidder !== p.pid && !a.passed.includes(p.pid) ? ['pass'] : null);
    if (ac) return [p.pid, ac[0], ac[1] || {}];
  }
  return null;
}

// ---------- save / restore rooms (survives a server restart) ----------
let saveTimer = null;
function scheduleSave() { if (!saveTimer) saveTimer = setTimeout(save, 2000); }
function save() {
  saveTimer = null;
  const data = [...rooms.values()].map(r => ({...r, socks:undefined, game:r.game ? JSON.parse(JSON.stringify(r.game)) : null}));
  fs.writeFile(SAVE_PATH + '.tmp', JSON.stringify(data), e => { if (!e) fs.rename(SAVE_PATH + '.tmp', SAVE_PATH, () => {}); });
}
try {
  for (const r of JSON.parse(fs.readFileSync(SAVE_PATH, 'utf8'))) {
    r.socks = new Map(); r.touched = Date.now(); r.lastAct = 0;
    r.members.forEach(m => { if (!m.bot) { m.connected = false; m.discAt = Date.now(); } });
    if (r.game) r.game = Game.from(r.game);
    rooms.set(r.code, r);
  }
  if (rooms.size) console.log(`Восстановлено комнат: ${rooms.size}`);
} catch (e) {}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-cache'});
    return res.end(PAGE.html);
  }
  if (url === '/api/rooms') {
    const list = [...rooms.values()].filter(r => !r.game && r.members.some(m => m.connected && !m.bot))
      .map(r => ({code:r.code, host:(mem(r, r.host) || {}).name, n:r.members.length}));
    res.writeHead(200, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});
    return res.end(JSON.stringify(list));
  }
  res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); res.end('Не найдено');
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url.split('?')[0] !== '/ws' || !key) return sock.destroy();
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  const ws = new WS(sock);
  ws.on('message', m => { try { onMessage(ws, m); } catch (e) { console.error(e); } });
  ws.on('close', () => onClose(ws));
});
// drop dead connections (phone went to sleep, Wi-Fi lost...)
setInterval(() => {
  for (const r of rooms.values()) for (const ws of r.socks.values()) {
    if (!ws.alive) { ws.closed(); continue; }
    ws.alive = false; ws.frame(0x9, Buffer.alloc(0));
  }
}, 20000);

function log(s) { console.log(new Date().toLocaleTimeString() + '  ' + s); }
function lanIPs(cb) {
  const ips = new Set();
  try { for (const list of Object.values(os.networkInterfaces())) for (const a of list) if (a.family === 'IPv4' || a.family === 4) if (!a.internal) ips.add(a.address); } catch (e) {}
  if (ips.size) return cb([...ips]);
  // Android may forbid listing interfaces: ask the routing table instead (no packets are sent)
  const s = dgram.createSocket('udp4');
  s.on('error', () => cb([]));
  s.connect(53, '8.8.8.8', () => { try { ips.add(s.address().address); } catch (e) {} s.close(); cb([...ips]); });
}
server.listen(PORT, '0.0.0.0', () => {
  lanIPs(ips => {
    console.log('\n  🎩 Сервер «Магнат» запущен!\n');
    console.log(`  На этом устройстве:   http://localhost:${PORT}`);
    for (const ip of ips) console.log(`  Для друзей (Wi-Fi):   http://${ip}:${PORT}`);
    if (!ips.length) console.log('  IP в локальной сети не найден — посмотрите его в настройках Wi-Fi');
    console.log('\n  Друзья должны быть в той же Wi-Fi сети или подключены к вашей точке доступа.');
    console.log('  Игра через интернет: см. README (cloudflared / localhost.run).');
    console.log('  Остановить сервер: Ctrl+C\n');
  });
});
function saveNow() { clearTimeout(saveTimer); saveTimer = null; try { fs.writeFileSync(SAVE_PATH, JSON.stringify([...rooms.values()].map(r => ({...r, socks:undefined})))); } catch (e) {} }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { saveNow(); console.log('\n  Сервер остановлен, игры сохранены.'); process.exit(0); });
