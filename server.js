const http = require('http'), fs = require('fs'), path = require('path');
const { Server } = require('socket.io');

const FINISH = 1600;    // jarak ke pelabuhan
const DURATION = 180;   // batas waktu (detik)
const HEARTS = 3;       // nyawa kapal
const FUEL = 60;        // BBM awal
const DT = 1 / 30;      // simulasi 30x per detik
const rooms = {};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const server = http.createServer((req, res) => {
  const file = req.url.startsWith('/play') ? 'play.html' : 'host.html';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(path.join(__dirname, file)));
});
const io = new Server(server);

const newCode = () => {
  let c;
  do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms[c]);
  return c;
};
const fresh = () => ({
  win: false, reason: '', ship: { x: 50, y: 0, v: 0, vx: 0, t: 1 }, thr: 1, fuel: FUEL, heat: 20,
  dead: 0, leak: false, leakT: 12, prog: 0, inv: 0, hit: 0, hearts: HEARTS,
  hits: 0, leakLoss: 0, overheats: 0, time: DURATION, n: 0, held: { L: false, R: false, T: false, D: false }
});

function makeMap() {
  const big = [], small = [], storms = [];
  const rnd = (a, b) => a + Math.random() * (b - a);
  for (let y = 200; y < FINISH - 80; y += 75) {
    big.push({ x: rnd(10, 90), y: y + rnd(0, 30), r: 6 });
    if (Math.random() < 0.5) big.push({ x: rnd(10, 90), y: y + rnd(0, 30), r: 6 });
    if (Math.random() < 0.6) small.push({ x: rnd(10, 90), y: y + rnd(0, 40), r: 3 });
  }
  for (let y = 400; y < FINISH - 200; y += 400) storms.push({ x: rnd(20, 80), y, r: 16, dir: Math.random() < 0.5 ? -1 : 1 });
  return { big, small, storms, all: big.concat(small) };
}

function pub(r) {
  const S = r.ship;
  return {
    code: r.code, state: r.state, win: r.win, reason: r.reason, players: r.players.map(p => p.name),
    time: Math.max(0, Math.ceil(r.time)), hearts: r.hearts, prog: Math.min(1, S.y / FINISH),
    x: S.x, y: S.y, v: S.v, leak: r.leak, dead: r.dead > 0, hit: r.hit > 0,
    hits: r.hits, leakLoss: r.leakLoss, overheats: r.overheats
  };
}
const dynOf = r => ({
  x: r.ship.x, y: r.ship.y, fuel: Math.round(r.fuel), heat: Math.round(r.heat), t: r.ship.t,
  dead: r.dead > 0, leak: r.leak, leakT: Math.ceil(r.leakT), prog: r.prog / 2.5
});
function push(r) {
  io.to(r.hostId).emit('state', pub(r));
  r.players.forEach((p, i) => { if (p.sid) io.to(p.sid).emit('view', { role: i, state: r.state, players: r.players.length }); });
}
function finish(r, win, reason) {
  r.state = 'end'; r.win = win; r.reason = reason;
  r.held = { L: false, R: false, T: false, D: false };
  clearInterval(r.timer);
  push(r);
}

function step(r) {
  const S = r.ship, h = r.held, m = r.map;
  S.t = (r.dead > 0 || r.fuel <= 0) ? 0 : r.thr;
  const t = S.t;
  if (r.dead > 0) r.dead -= DT;
  r.inv -= DT; r.hit -= DT;

  // Kecepatan maju (diatur Kepala Mesin)
  const tv = t * 8;
  S.v += Math.sign(tv - S.v) * Math.min(Math.abs(tv - S.v), 20 * DT);

  // Belok kiri/kanan (diatur Juru Mudi)
  const dir = (h.R ? 1 : 0) - (h.L ? 1 : 0), tx = dir * 22;
  S.vx += Math.sign(tx - S.vx) * Math.min(Math.abs(tx - S.vx), (dir ? 90 : 60) * DT);

  // Badai: kapal terdorong ke samping dan mesin lebih panas
  const st = m.storms.find(s => Math.hypot(S.x - s.x, S.y - s.y) < s.r);
  if (st) { S.x += st.dir * 12 * DT; r.heat += 4 * DT; }
  S.x = clamp(S.x + S.vx * DT, 3, 97);
  S.y += S.v * DT;

  // BBM dan suhu mesin
  r.fuel = Math.max(0, r.fuel - (0.05 * t * t + 0.1 * t) * DT);
  r.heat += t > 3 ? (t - 3) * 3 * DT : -(4 - t) * 1.5 * DT;
  if (h.D && t <= 2) r.heat -= 15 * DT;      // Kru Teknis mendinginkan (kapal harus pelan)
  r.heat = clamp(r.heat, 0, 100);
  if (r.heat >= 100) { r.dead = 6; r.heat = 55; r.thr = 1; r.overheats++; }

  // Bocor: harus ditambal Kru Teknis saat kapal pelan
  if (r.leak) {
    if (h.T && t <= 2) { r.prog += DT; if (r.prog >= 2.5) { r.leak = false; r.prog = 0; } }
    else r.prog = 0;
    r.leakT -= DT;
    if (r.leak && r.leakT <= 0) { r.hearts--; r.leakLoss++; r.leakT = 12; }
  }

  // Tabrakan karang
  if (r.inv <= 0) {
    const k = m.all.find(k => Math.hypot(S.x - k.x, S.y - k.y) < k.r + 2.5);
    if (k) {
      r.hearts--; r.hits++; S.v = 0; S.vx = 0; S.y -= 8; r.thr = Math.min(r.thr, 1);
      r.leak = true; r.leakT = 12; r.prog = 0; r.inv = 1.5; r.hit = 0.4;
    }
  }

  r.time -= DT;
  if (S.y >= FINISH) return finish(r, true, 'Kapal sampai di pelabuhan');
  if (r.hearts <= 0) return finish(r, false, 'Nyawa kapal habis');
  if (r.fuel <= 0 && S.v < 0.5) return finish(r, false, 'BBM habis');
  if (r.time <= 0) finish(r, false, 'Waktu habis');
}

io.on('connection', socket => {
  socket.on('host', () => {
    const r = Object.assign({ code: newCode(), hostId: socket.id, state: 'lobby', players: [] }, fresh());
    rooms[r.code] = r;
    socket.data.room = r.code; socket.data.isHost = true;
    push(r);
  });

  socket.on('join', ({ room, name, token }, ack) => {
    const r = rooms[(room || '').toUpperCase()];
    if (!r) return ack({ err: 'Room tidak ditemukan. Scan ulang QR.' });
    let i = r.players.findIndex(p => p.token === token);
    if (i >= 0) r.players[i].sid = socket.id;
    else {
      if (r.state !== 'lobby' || r.players.length >= 4) return ack({ err: 'Room penuh atau game sudah mulai.' });
      r.players.push({ token, name: String(name || 'Peserta').replace(/[<>&"'`]/g, '').slice(0, 12), sid: socket.id });
    }
    socket.data.room = r.code;
    ack({ ok: true });
    if (r.state === 'play') socket.emit('map', r.mapPub);
    push(r);
  });

  socket.on('start', () => {
    const r = rooms[socket.data.room];
    if (!r || !socket.data.isHost || r.state !== 'lobby' || r.players.length !== 4) return;
    Object.assign(r, fresh(), { state: 'play', map: makeMap() });
    r.mapPub = { big: r.map.big, small: r.map.small, storms: r.map.storms, finish: FINISH };
    r.players.forEach(p => p.sid && io.to(p.sid).emit('map', r.mapPub));
    push(r);
    r.timer = setInterval(() => {
      step(r);
      if (r.state !== 'play') return;
      r.n++;
      io.to(r.hostId).emit('state', pub(r));
      if (r.n % 3 === 0) r.players.forEach(p => p.sid && io.to(p.sid).emit('dyn', dynOf(r)));
    }, 1000 * DT);
  });

  socket.on('again', () => {
    const r = rooms[socket.data.room];
    if (!r || !socket.data.isHost || r.state !== 'end') return;
    r.state = 'lobby';
    push(r);
  });

  // Tombol tahan: Juru Mudi (L/R) dan Kru Teknis (T/D)
  socket.on('hold', ({ k, on }) => {
    const r = rooms[socket.data.room];
    if (!r || r.state !== 'play') return;
    const i = r.players.findIndex(p => p.sid === socket.id);
    const ok = { 1: ['L', 'R'], 3: ['T', 'D'] }[i];
    if (ok && ok.includes(k)) r.held[k] = !!on;
  });

  // Tombol ketuk: Kepala Mesin menaik/menurunkan gigi
  socket.on('thr', ({ d }) => {
    const r = rooms[socket.data.room];
    if (!r || r.state !== 'play') return;
    const i = r.players.findIndex(p => p.sid === socket.id);
    if (i === 2) r.thr = clamp(r.thr + (d > 0 ? 1 : -1), 0, 5);
  });

  socket.on('disconnect', () => {
    const r = rooms[socket.data.room];
    if (!r) return;
    if (socket.data.isHost) { clearInterval(r.timer); delete rooms[r.code]; return; }
    const i = r.players.findIndex(p => p.sid === socket.id);
    if (i < 0) return;
    if (i === 1) r.held.L = r.held.R = false;
    if (i === 3) r.held.T = r.held.D = false;
    if (r.state === 'lobby') { r.players.splice(i, 1); push(r); }
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Jalan di port ' + (process.env.PORT || 3000)));
