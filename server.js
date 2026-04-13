const express  = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, {
  cors: {
    origin: [
      'https://darkaiser2.github.io',
      /^http:\/\/localhost(:\d+)?$/
    ],
    methods: ['GET', 'POST']
  }
});

const PORT        = process.env.PORT || 3000;
const MAX_HISTORY = 50;
const history     = [];
let   userCount   = 0;

app.get('/health', (_req, res) => res.json({ ok: true, users: userCount }));

// ── Helpers ───────────────────────────────────────────────────────────────────
function randomHandle() {
  return 'GHOST_' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

// ══════════════════════════════════════════════════════════════════════════════
// VOID SERPENT — Server-side Game Engine
// ══════════════════════════════════════════════════════════════════════════════
const GRID         = 26;
const TICK_BASE    = 145;  // ms base tick speed
const TICK_MIN     = 68;   // ms fastest tick
const SHRINK_EVERY = 28;   // ticks between arena shrinks
const REAPER_TICK  = 38;   // tick when Reaper spawns

const SNAKE_COLORS = [
  '#ff1a1a', '#39ff14', '#bf00ff', '#ff6600',
  '#ffff33', '#00f5ff', '#ff69b4', '#adff2f',
];

const DX  = { right: 1, left: -1, up:  0, down: 0 };
const DY  = { right: 0, left:  0, up: -1, down: 1 };
const OPP = { right: 'left', left: 'right', up: 'down', down: 'up' };

let G = {
  status:   'idle',   // idle | countdown | playing | gameover
  players:  {},       // socketId → player object
  ghosts:   [],       // [{body, color, until}]
  food:     [],       // [{x, y, cursed}]
  reaper:   null,     // {x, y, dir} or null
  arena:    { x1: 0, y1: 0, x2: GRID - 1, y2: GRID - 1 },
  tick:     0,
  loop:     null,     // setTimeout handle
  cdTimer:  null,
  colorIdx: 0,
};

// ── Game helpers ──────────────────────────────────────────────────────────────
function occupiedSet() {
  const s = new Set();
  Object.values(G.players).forEach(p => p.body.forEach(c => s.add(`${c.x},${c.y}`)));
  G.ghosts.forEach(g => g.body.forEach(c => s.add(`${c.x},${c.y}`)));
  G.food.forEach(f => s.add(`${f.x},${f.y}`));
  if (G.reaper) s.add(`${G.reaper.x},${G.reaper.y}`);
  return s;
}

function spawnFood() {
  const { x1, y1, x2, y2 } = G.arena;
  const occ = occupiedSet();
  for (let i = 0; i < 80; i++) {
    const x = x1 + 1 + Math.floor(Math.random() * (x2 - x1 - 1));
    const y = y1 + 1 + Math.floor(Math.random() * (y2 - y1 - 1));
    if (!occ.has(`${x},${y}`)) {
      G.food.push({ x, y, cursed: Math.random() < 0.22 });
      return;
    }
  }
}

function tickSpeed() {
  const total = Object.keys(G.players).length;
  const alive = Object.values(G.players).filter(p => p.alive).length;
  if (total === 0) return TICK_BASE;
  const deadRatio = (total - alive) / total;
  return Math.max(TICK_MIN, TICK_BASE - Math.floor(deadRatio * 77));
}

function resetGame() {
  if (G.loop)    { clearTimeout(G.loop);     G.loop    = null; }
  if (G.cdTimer) { clearInterval(G.cdTimer); G.cdTimer = null; }

  G.ghosts = [];
  G.food   = [];
  G.reaper = null;
  G.arena  = { x1: 0, y1: 0, x2: GRID - 1, y2: GRID - 1 };
  G.tick   = 0;

  const ids = Object.keys(G.players);
  const spawns = [
    { x: 2,              y: 2,              dir: 'right' },
    { x: GRID - 3,       y: GRID - 3,       dir: 'left'  },
    { x: GRID - 3,       y: 2,              dir: 'left'  },
    { x: 2,              y: GRID - 3,       dir: 'right' },
    { x: Math.floor(GRID/2), y: 2,          dir: 'down'  },
    { x: Math.floor(GRID/2), y: GRID - 3,   dir: 'up'    },
    { x: 2,              y: Math.floor(GRID/2), dir: 'right' },
    { x: GRID - 3,       y: Math.floor(GRID/2), dir: 'left'  },
  ];

  ids.forEach((id, i) => {
    const sp = spawns[i % spawns.length];
    const p  = G.players[id];
    p.alive       = true;
    p.score       = 0;
    p.cursedTicks = 0;
    p.ready       = false;
    p.dir         = sp.dir;
    p.nextDir     = sp.dir;
    p.body = [
      { x: sp.x,               y: sp.y               },
      { x: sp.x - DX[sp.dir],  y: sp.y - DY[sp.dir]  },
      { x: sp.x - DX[sp.dir]*2, y: sp.y - DY[sp.dir]*2 },
    ];
  });

  for (let i = 0; i < Math.max(3, ids.length); i++) spawnFood();
}

function killPlayer(id, now) {
  const p = G.players[id];
  if (!p || !p.alive) return;
  p.alive = false;
  G.ghosts.push({ body: p.body.slice(), color: p.color, until: now + 7000 });
  io.emit('game_event', { type: 'death', id, username: p.username, color: p.color });
}

function moveReaper() {
  const r = G.reaper;
  if (!r) return;
  let target = null, minDist = Infinity;
  Object.values(G.players).forEach(p => {
    if (!p.alive) return;
    const h = p.body[0];
    const d = Math.abs(h.x - r.x) + Math.abs(h.y - r.y);
    if (d < minDist) { minDist = d; target = h; }
  });
  if (!target) return;
  const { x1, y1, x2, y2 } = G.arena;
  const preferred = [];
  if (target.x > r.x) preferred.push('right');
  if (target.x < r.x) preferred.push('left');
  if (target.y > r.y) preferred.push('down');
  if (target.y < r.y) preferred.push('up');
  const dirs = [...preferred, ...['right','left','up','down'].filter(d => !preferred.includes(d))];
  for (const d of dirs) {
    const nx = r.x + DX[d], ny = r.y + DY[d];
    if (nx >= x1 && nx <= x2 && ny >= y1 && ny <= y2) {
      r.x = nx; r.y = ny; r.dir = d; break;
    }
  }
}

function scheduleNext() {
  if (G.status !== 'playing') return;
  G.loop = setTimeout(() => { tickGame(); scheduleNext(); }, tickSpeed());
}

function startGame() {
  resetGame();
  G.status = 'playing';
  io.emit('game_start', buildState());
  scheduleNext();
}

function startCountdown() {
  G.status    = 'countdown';
  G.countdown = 3;
  io.emit('game_countdown', 3);
  G.cdTimer = setInterval(() => {
    G.countdown--;
    if (G.countdown <= 0) {
      clearInterval(G.cdTimer); G.cdTimer = null;
      startGame();
    } else {
      io.emit('game_countdown', G.countdown);
    }
  }, 1000);
}

function tickGame() {
  if (G.status !== 'playing') return;
  G.tick++;
  const now = Date.now();

  // Expire ghosts
  G.ghosts = G.ghosts.filter(g => now < g.until);

  // Decay cursed ticks
  Object.values(G.players).forEach(p => { if (p.cursedTicks > 0) p.cursedTicks--; });

  // Shrink arena
  if (G.tick > 15 && G.tick % SHRINK_EVERY === 0) {
    const half = Math.floor(GRID / 2);
    if (G.arena.x1 < half - 4) {
      G.arena.x1++; G.arena.y1++;
      G.arena.x2--; G.arena.y2--;
      io.emit('game_event', { type: 'shrink', arena: G.arena });
    }
  }

  // Spawn Reaper
  if (G.tick === REAPER_TICK && !G.reaper) {
    G.reaper = { x: Math.floor(GRID/2), y: Math.floor(GRID/2), dir: 'right' };
    io.emit('game_event', { type: 'reaper_spawn' });
  }

  // Move Reaper every 2 ticks
  if (G.reaper && G.tick % 2 === 0) moveReaper();

  // Build obstacle set (body segments, excluding each player's own current head)
  const obstacles = new Set();
  Object.values(G.players).forEach(p => {
    if (!p.alive) return;
    p.body.slice(1).forEach(s => obstacles.add(`${s.x},${s.y}`));
  });
  G.ghosts.forEach(g => g.body.forEach(s => obstacles.add(`${s.x},${s.y}`)));

  // Compute new heads
  const newHeads = {};
  Object.entries(G.players).forEach(([id, p]) => {
    if (!p.alive) return;
    if (p.nextDir !== OPP[p.dir]) p.dir = p.nextDir;
    const moveDir = p.cursedTicks > 0 ? OPP[p.dir] : p.dir;
    const h = p.body[0];
    newHeads[id] = { x: h.x + DX[moveDir], y: h.y + DY[moveDir] };
  });

  // Collision detection
  const dying = new Set();
  Object.entries(newHeads).forEach(([id, h]) => {
    if (h.x < G.arena.x1 || h.x > G.arena.x2 || h.y < G.arena.y1 || h.y > G.arena.y2) { dying.add(id); return; }
    if (obstacles.has(`${h.x},${h.y}`)) { dying.add(id); return; }
    if (G.reaper && h.x === G.reaper.x && h.y === G.reaper.y) { dying.add(id); return; }
  });

  // Head-to-head
  const headPos = {};
  Object.entries(newHeads).forEach(([id, h]) => {
    if (dying.has(id)) return;
    const k = `${h.x},${h.y}`;
    if (headPos[k]) { dying.add(id); dying.add(headPos[k]); } else headPos[k] = id;
  });

  // Kill colliders
  dying.forEach(id => killPlayer(id, now));

  // Move survivors
  Object.entries(G.players).forEach(([id, p]) => {
    if (!p.alive || dying.has(id)) return;
    const h = newHeads[id];
    p.body.unshift(h);

    const fi = G.food.findIndex(f => f.x === h.x && f.y === h.y);
    if (fi >= 0) {
      const food = G.food.splice(fi, 1)[0];
      p.score++;
      if (food.cursed) {
        p.cursedTicks = 6;
        io.to(id).emit('game_event', { type: 'cursed' });
      }
      spawnFood();
    } else {
      p.body.pop();
    }
  });

  // Check game over
  const alive = Object.values(G.players).filter(p => p.alive);
  const total = Object.keys(G.players).length;

  if (total >= 2 && alive.length <= 1) {
    if (G.loop) { clearTimeout(G.loop); G.loop = null; }
    G.status = 'gameover';
    const winner = alive[0] || null;
    io.emit('game_over', {
      winner: winner ? { username: winner.username, color: winner.color, score: winner.score } : null,
      scores: Object.values(G.players)
        .map(p => ({ username: p.username, color: p.color, score: p.score, alive: p.alive }))
        .sort((a, b) => b.score - a.score),
    });
    return;
  }

  io.emit('game_state', buildState());
}

function buildState() {
  return {
    status:  G.status,
    players: Object.entries(G.players).map(([id, p]) => ({
      id, username: p.username, color: p.color,
      body: p.alive ? p.body : [],
      alive: p.alive, score: p.score, cursed: p.cursedTicks > 0, dir: p.dir,
    })),
    ghosts:  G.ghosts.map(g => ({ body: g.body, color: g.color })),
    food:    G.food,
    reaper:  G.reaper,
    arena:   G.arena,
    tick:    G.tick,
  };
}

function buildLobby() {
  return {
    status:  G.status,
    players: Object.entries(G.players).map(([id, p]) => ({
      id, username: p.username, color: p.color, ready: p.ready,
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Socket.io — Chat + Game Events
// ══════════════════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  userCount++;
  socket.username   = randomHandle();
  socket.lastMsg    = 0;

  socket.emit('history', history);
  socket.emit('assigned_username', socket.username);
  io.emit('user_count', userCount);
  io.emit('sys_msg', { text: `${socket.username} connected`, ts: Date.now() });

  // ── Chat ──────────────────────────────────────────────────────────────────
  socket.on('set_username', (raw) => {
    if (typeof raw !== 'string') return;
    const name = raw.replace(/[^a-zA-Z0-9_]/g, '').substring(0, 16).toUpperCase();
    if (name.length < 2) return;
    const old = socket.username;
    socket.username = name;
    if (G.players[socket.id]) G.players[socket.id].username = name;
    socket.emit('assigned_username', name);
    io.emit('sys_msg', { text: `${old} → ${name}`, ts: Date.now() });
  });

  socket.on('message', (raw) => {
    if (typeof raw !== 'string') return;
    const now = Date.now();
    if (now - socket.lastMsg < 500) return;
    socket.lastMsg = now;
    const text = raw.trim().substring(0, 200);
    if (!text) return;
    const msg = { user: socket.username, text, ts: now };
    history.push(msg);
    if (history.length > MAX_HISTORY) history.shift();
    io.emit('message', msg);
  });

  // ── Game ──────────────────────────────────────────────────────────────────
  socket.on('game_join', () => {
    if (G.status === 'playing' || G.status === 'countdown') return;
    if (G.players[socket.id]) return; // already in

    const colorI = G.colorIdx % SNAKE_COLORS.length;
    G.colorIdx++;

    G.players[socket.id] = {
      username:    socket.username,
      color:       SNAKE_COLORS[colorI],
      body:        [],
      dir:         'right',
      nextDir:     'right',
      alive:       true,
      score:       0,
      cursedTicks: 0,
      ready:       false,
    };

    socket.emit('game_joined', { color: SNAKE_COLORS[colorI] });
    io.emit('game_lobby', buildLobby());
  });

  socket.on('game_leave', () => {
    if (!G.players[socket.id]) return;
    delete G.players[socket.id];
    io.emit('game_lobby', buildLobby());
    if (G.status === 'playing') {
      const alive = Object.values(G.players).filter(p => p.alive).length;
      if (alive <= 1 && Object.keys(G.players).length >= 1) {
        // Trigger end check on next tick — handled naturally
      }
    }
  });

  socket.on('game_ready', () => {
    const p = G.players[socket.id];
    if (!p || G.status !== 'idle') return;
    p.ready = true;
    io.emit('game_lobby', buildLobby());
    const all = Object.values(G.players);
    if (all.length >= 2 && all.every(pl => pl.ready)) startCountdown();
  });

  socket.on('game_reset_ready', () => {
    const p = G.players[socket.id];
    if (p && G.status === 'gameover') {
      p.ready = false;
      G.status = 'idle';
      io.emit('game_lobby', buildLobby());
    }
  });

  socket.on('game_direction', (dir) => {
    const p = G.players[socket.id];
    if (p && p.alive && ['up','down','left','right'].includes(dir)) {
      p.nextDir = dir;
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    userCount = Math.max(0, userCount - 1);
    io.emit('user_count', userCount);
    io.emit('sys_msg', { text: `${socket.username} disconnected`, ts: Date.now() });

    if (G.players[socket.id]) {
      delete G.players[socket.id];
      io.emit('game_lobby', buildLobby());
    }
  });
});

httpServer.listen(PORT, () =>
  console.log(`[server] Listening on port ${PORT}`)
);
