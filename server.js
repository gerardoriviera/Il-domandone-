// Il Domandone — server multigiocatore senza dipendenze.
// Server -> client: Server-Sent Events (GET /api/events). Client -> server: POST JSON.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QUESTION_BANK = require('./questions');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 10;
const QUESTIONS_PER_ROUND = 10;
const QUESTION_TIME_MS = 20000;
const REVEAL_TIME_MS = 6000;
const COUNTDOWN_MS = 3000;
const MAX_POINTS = 1000;
const MIN_POINTS = 500; // punti per una risposta corretta data all'ultimo istante
const LOBBY_GRACE_MS = 15000; // tempo per riconnettersi prima di essere rimossi dalla lobby
const ROOM_IDLE_MS = 10 * 60 * 1000;

const rooms = new Map();

// ---------- utilità ----------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function pickQuestions() {
  return shuffle(QUESTION_BANK).slice(0, QUESTIONS_PER_ROUND).map((item) => {
    const options = shuffle([item.a, ...item.w]);
    return { q: item.q, options, correct: options.indexOf(item.a) };
  });
}

function pointsFor(ms) {
  const ratio = Math.min(Math.max(ms / QUESTION_TIME_MS, 0), 1);
  return Math.round(MAX_POINTS - (MAX_POINTS - MIN_POINTS) * ratio);
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

// ---------- logica di gioco ----------
function connectedPlayers(room) {
  return [...room.players.values()].filter((p) => p.streams.size > 0);
}

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && host.streams.size > 0) return;
  const next = connectedPlayers(room)[0];
  if (next) room.hostId = next.id;
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function startGame(room) {
  clearTimer(room);
  room.questions = pickQuestions();
  room.qIndex = -1;
  for (const p of room.players.values()) {
    p.score = 0;
    p.correctCount = 0;
    p.answer = null;
  }
  room.state = 'countdown';
  room.phaseEnds = Date.now() + COUNTDOWN_MS;
  room.timer = setTimeout(() => nextQuestion(room), COUNTDOWN_MS);
  broadcast(room);
}

function nextQuestion(room) {
  clearTimer(room);
  room.qIndex++;
  if (room.qIndex >= room.questions.length) {
    room.state = 'final';
    room.phaseEnds = null;
    broadcast(room);
    return;
  }
  for (const p of room.players.values()) p.answer = null;
  room.state = 'question';
  room.qStart = Date.now();
  room.phaseEnds = room.qStart + QUESTION_TIME_MS;
  room.timer = setTimeout(() => reveal(room), QUESTION_TIME_MS);
  broadcast(room);
}

function reveal(room) {
  if (room.state !== 'question') return;
  clearTimer(room);
  const q = room.questions[room.qIndex];
  for (const p of room.players.values()) {
    if (p.answer && p.answer.choice === q.correct) {
      p.answer.points = pointsFor(p.answer.ms);
      p.score += p.answer.points;
      p.correctCount++;
    } else if (p.answer) {
      p.answer.points = 0;
    }
  }
  room.state = 'reveal';
  room.phaseEnds = Date.now() + REVEAL_TIME_MS;
  room.timer = setTimeout(() => nextQuestion(room), REVEAL_TIME_MS);
  broadcast(room);
}

function maybeEndQuestionEarly(room) {
  if (room.state !== 'question') return;
  const online = connectedPlayers(room);
  if (online.length > 0 && online.every((p) => p.answer)) {
    clearTimer(room);
    room.timer = setTimeout(() => reveal(room), 600);
  }
}

function backToLobby(room) {
  clearTimer(room);
  room.state = 'lobby';
  room.phaseEnds = null;
  room.questions = [];
  room.qIndex = -1;
  // chi si è disconnesso durante la partita esce dalla stanza
  for (const p of [...room.players.values()]) {
    if (p.streams.size === 0) room.players.delete(p.id);
  }
  for (const p of room.players.values()) {
    p.score = 0;
    p.correctCount = 0;
    p.answer = null;
  }
  ensureHost(room);
  broadcast(room);
}

// ---------- stato inviato ai client ----------
function ranking(room) {
  return [...room.players.values()]
    .map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      correctCount: p.correctCount,
      connected: p.streams.size > 0,
      answered: !!p.answer,
      lastPoints: p.answer ? p.answer.points ?? null : null,
      lastMs: p.answer ? p.answer.ms : null,
      lastChoice: room.state === 'reveal' && p.answer ? p.answer.choice : null,
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function viewFor(room, player) {
  const view = {
    room: room.code,
    state: room.state,
    you: player.id,
    hostId: room.hostId,
    maxPlayers: MAX_PLAYERS,
    total: QUESTIONS_PER_ROUND,
    questionTime: QUESTION_TIME_MS,
    remainingMs: room.phaseEnds ? Math.max(0, room.phaseEnds - Date.now()) : null,
    players: ranking(room),
  };
  if (room.state === 'question' || room.state === 'reveal') {
    const q = room.questions[room.qIndex];
    view.qIndex = room.qIndex;
    view.question = { text: q.q, options: q.options };
    view.yourAnswer = player.answer ? player.answer.choice : null;
    if (room.state === 'reveal') {
      view.question.correct = q.correct;
      view.yourPoints = player.answer ? player.answer.points : 0;
    }
  }
  return view;
}

function send(player, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of player.streams) res.write(data);
}

function broadcast(room) {
  room.lastActivity = Date.now();
  for (const p of room.players.values()) send(p, viewFor(room, p));
}

// ---------- HTTP ----------
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

function findPlayer(body) {
  const room = rooms.get(String(body.room || '').toUpperCase());
  if (!room) return {};
  const player = [...room.players.values()].find((p) => p.token === body.token);
  return { room, player };
}

function addPlayer(room, name) {
  const player = {
    id: crypto.randomUUID().slice(0, 8),
    token: crypto.randomUUID(),
    name,
    score: 0,
    correctCount: 0,
    answer: null,
    streams: new Set(),
    leaveTimer: null,
  };
  room.players.set(player.id, player);
  return player;
}

const api = {
  async create(body) {
    const name = cleanName(body.name);
    if (!name) return [400, { error: 'Inserisci un nickname.' }];
    const room = {
      code: makeRoomCode(),
      players: new Map(),
      hostId: null,
      state: 'lobby',
      questions: [],
      qIndex: -1,
      phaseEnds: null,
      timer: null,
      lastActivity: Date.now(),
    };
    rooms.set(room.code, room);
    const player = addPlayer(room, name);
    room.hostId = player.id;
    return [200, { room: room.code, token: player.token }];
  },

  async join(body) {
    const name = cleanName(body.name);
    const room = rooms.get(String(body.room || '').trim().toUpperCase());
    if (!name) return [400, { error: 'Inserisci un nickname.' }];
    if (!room) return [404, { error: 'Stanza non trovata. Controlla il codice.' }];
    if (room.state !== 'lobby' && room.state !== 'final') return [409, { error: 'La partita è già iniziata. Aspetta la fine del round.' }];
    if (room.players.size >= MAX_PLAYERS) return [409, { error: `Stanza piena (max ${MAX_PLAYERS} giocatori).` }];
    const taken = [...room.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return [409, { error: 'Nickname già in uso in questa stanza.' }];
    const player = addPlayer(room, name);
    broadcast(room);
    return [200, { room: room.code, token: player.token }];
  },

  async start(body) {
    const { room, player } = findPlayer(body);
    if (!player) return [404, { error: 'Sessione non valida.' }];
    if (room.hostId !== player.id) return [403, { error: 'Solo l\'host può avviare la partita.' }];
    if (room.state !== 'lobby' && room.state !== 'final') return [409, { error: 'Partita già in corso.' }];
    startGame(room);
    return [200, { ok: true }];
  },

  async answer(body) {
    const { room, player } = findPlayer(body);
    if (!player) return [404, { error: 'Sessione non valida.' }];
    const choice = Number(body.choice);
    if (room.state !== 'question' || Number(body.qIndex) !== room.qIndex) return [409, { error: 'Tempo scaduto.' }];
    if (player.answer) return [409, { error: 'Hai già risposto.' }];
    if (!Number.isInteger(choice) || choice < 0 || choice >= room.questions[room.qIndex].options.length) {
      return [400, { error: 'Risposta non valida.' }];
    }
    player.answer = { choice, ms: Date.now() - room.qStart, points: null };
    broadcast(room);
    maybeEndQuestionEarly(room);
    return [200, { ok: true }];
  },

  async lobby(body) {
    const { room, player } = findPlayer(body);
    if (!player) return [404, { error: 'Sessione non valida.' }];
    if (room.hostId !== player.id) return [403, { error: 'Solo l\'host può farlo.' }];
    backToLobby(room);
    return [200, { ok: true }];
  },

  async leave(body) {
    const { room, player } = findPlayer(body);
    if (!player) return [200, { ok: true }];
    for (const res of player.streams) res.end();
    room.players.delete(player.id);
    if (room.players.size === 0) {
      clearTimer(room);
      rooms.delete(room.code);
      return [200, { ok: true }];
    }
    ensureHost(room);
    broadcast(room);
    maybeEndQuestionEarly(room);
    return [200, { ok: true }];
  },
};

function handleEvents(req, res, url) {
  const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
  const token = url.searchParams.get('token');
  const player = room && [...room.players.values()].find((p) => p.token === token);
  if (!player) {
    res.writeHead(404, { 'Content-Type': 'text/event-stream' });
    res.end('event: gone\ndata: {}\n\n');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  if (player.leaveTimer) clearTimeout(player.leaveTimer);
  player.leaveTimer = null;
  player.streams.add(res);
  ensureHost(room);
  broadcast(room);

  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    player.streams.delete(res);
    if (!rooms.has(room.code) || player.streams.size > 0) return;
    ensureHost(room);
    broadcast(room);
    maybeEndQuestionEarly(room);
    if (room.state === 'lobby' || room.state === 'final') {
      player.leaveTimer = setTimeout(() => {
        if (player.streams.size > 0 || room.players.get(player.id) !== player) return;
        room.players.delete(player.id);
        ensureHost(room);
        broadcast(room);
      }, LOBBY_GRACE_MS);
    }
  });
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    fs.readFile(path.join(__dirname, 'public', file), (err, data) => {
      if (err) return json(res, 500, { error: 'File mancante' });
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/events') return handleEvents(req, res, url);
  const action = url.pathname.startsWith('/api/') && api[url.pathname.slice(5)];
  if (req.method === 'POST' && action) {
    const [status, body] = await action(await readBody(req));
    return json(res, status, body);
  }
  json(res, 404, { error: 'Non trovato' });
});

// rimuove le stanze abbandonate
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (connectedPlayers(room).length === 0 && now - room.lastActivity > ROOM_IDLE_MS) {
      clearTimer(room);
      rooms.delete(room.code);
    }
  }
}, 60000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Il Domandone è online!\n`);
  console.log(`  Su questo computer:  http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) console.log(`  Nella rete locale:   http://${net.address}:${PORT}`);
    }
  }
  console.log('');
});
