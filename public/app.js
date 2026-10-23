// Il Domandone — gioco multigiocatore peer-to-peer (WebRTC tramite PeerJS).
// Il browser di chi crea la stanza (l'host) fa da "server": tiene lo stato della partita,
// i timer e i punteggi. Gli altri giocatori si collegano direttamente a lui.
(() => {
  const MAX_PLAYERS = 10;
  const QUESTIONS_PER_ROUND = 10;
  const QUESTION_TIME_MS = 20000;
  const REVEAL_TIME_MS = 6000;
  const COUNTDOWN_MS = 3000;
  const MAX_POINTS = 1000;
  const MIN_POINTS = 500; // punti per una risposta corretta data all'ultimo istante
  const LOBBY_GRACE_MS = 15000; // tempo per riconnettersi prima di essere rimossi dalla lobby
  const HEARTBEAT_MS = 3000;
  const HEARTBEAT_TIMEOUT_MS = 12000;
  const PEER_PREFIX = 'il-domandone-v1-';
  // Permette di usare un PeerServer diverso da quello pubblico di PeerJS (es. nei test).
  const PEER_OPTIONS = window.DOMANDONE_PEER_OPTIONS || {};

  // ---------- utilità ----------
  function randomInt(n) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % n;
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function makeRoomCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    return Array.from({ length: 4 }, () => letters[randomInt(letters.length)]).join('');
  }
  function makeId() {
    return crypto.getRandomValues(new Uint32Array(4)).join('-');
  }
  function cleanName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  }
  function pointsFor(ms) {
    const ratio = Math.min(Math.max(ms / QUESTION_TIME_MS, 0), 1);
    return Math.round(MAX_POINTS - (MAX_POINTS - MIN_POINTS) * ratio);
  }
  function openPeer(id) {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, PEER_OPTIONS) : new Peer(PEER_OPTIONS);
      const onError = (err) => { peer.destroy(); reject(err); };
      peer.once('open', () => { peer.off('error', onError); resolve(peer); });
      peer.once('error', onError);
    });
  }

  // =====================================================================
  //  HOST: motore di gioco
  // =====================================================================
  class HostGame {
    constructor(code) {
      this.code = code;
      this.players = new Map();
      this.hostId = null;
      this.state = 'lobby';
      this.questions = [];
      this.qIndex = -1;
      this.qStart = 0;
      this.phaseEnds = null;
      this.timer = null;
      this.heartbeat = setInterval(() => this.checkHeartbeats(), 2000);
    }

    addPlayer(name, send) {
      const player = {
        id: makeId(), token: makeId(), name, score: 0, correctCount: 0, answer: null,
        connected: true, send, conn: null, lastSeen: Date.now(), leaveTimer: null,
      };
      this.players.set(player.id, player);
      return player;
    }

    online() {
      return [...this.players.values()].filter((p) => p.connected);
    }

    // ----- connessioni dei giocatori remoti -----
    attach(conn) {
      conn.on('data', (msg) => this.onMessage(conn, msg));
      conn.on('close', () => this.onConnClosed(conn));
      conn.on('error', () => this.onConnClosed(conn));
    }

    onMessage(conn, msg) {
      if (!msg || typeof msg !== 'object') return;
      const player = conn.player;
      if (player) player.lastSeen = Date.now();
      if (msg.t === 'join') return this.onJoin(conn, msg);
      if (!player) return;
      if (msg.t === 'answer') this.answer(player, msg.choice, msg.qIndex, msg.ms);
      else if (msg.t === 'leave') this.remove(player);
    }

    onJoin(conn, msg) {
      const reject = (message) => {
        conn.send({ t: 'error', message });
        setTimeout(() => conn.close(), 500);
      };
      // riconnessione di un giocatore già presente
      const existing = msg.token && [...this.players.values()].find((p) => p.token === msg.token);
      if (existing) {
        if (existing.conn && existing.conn !== conn) existing.conn.close();
        this.bind(existing, conn);
        return;
      }
      const name = cleanName(msg.name);
      if (!name) return reject('Inserisci un nickname.');
      if (this.state !== 'lobby' && this.state !== 'final') return reject('La partita è già iniziata. Aspetta la fine del round.');
      if (this.players.size >= MAX_PLAYERS) return reject(`Stanza piena (max ${MAX_PLAYERS} giocatori).`);
      if ([...this.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        return reject('Nickname già in uso in questa stanza.');
      }
      this.bind(this.addPlayer(name, null), conn);
    }

    bind(player, conn) {
      conn.player = player;
      player.conn = conn;
      player.connected = true;
      player.lastSeen = Date.now();
      clearTimeout(player.leaveTimer);
      player.send = (view) => { if (conn.open) conn.send({ t: 'state', view }); };
      conn.send({ t: 'joined', token: player.token });
      this.broadcast();
    }

    onConnClosed(conn) {
      const player = conn.player;
      if (!player || player.conn !== conn || !player.connected) return;
      player.connected = false;
      player.conn = null;
      this.broadcast();
      this.maybeEndQuestionEarly();
      if (this.state === 'lobby' || this.state === 'final') {
        player.leaveTimer = setTimeout(() => {
          if (!player.connected && this.players.get(player.id) === player) this.remove(player);
        }, LOBBY_GRACE_MS);
      }
    }

    checkHeartbeats() {
      const now = Date.now();
      for (const p of this.players.values()) {
        if (p.conn && now - p.lastSeen > HEARTBEAT_TIMEOUT_MS) {
          const conn = p.conn;
          this.onConnClosed(conn);
          conn.close();
        }
      }
    }

    remove(player) {
      clearTimeout(player.leaveTimer);
      if (player.conn) player.conn.close();
      this.players.delete(player.id);
      this.broadcast();
      this.maybeEndQuestionEarly();
    }

    // ----- flusso di gioco -----
    clearTimer() {
      clearTimeout(this.timer);
      this.timer = null;
    }

    start() {
      if (this.state !== 'lobby' && this.state !== 'final') return;
      this.clearTimer();
      this.questions = shuffle(window.QUESTIONS).slice(0, QUESTIONS_PER_ROUND).map((item) => {
        const options = shuffle([item.a, ...item.w]);
        return { q: item.q, options, correct: options.indexOf(item.a) };
      });
      this.qIndex = -1;
      for (const p of this.players.values()) {
        p.score = 0;
        p.correctCount = 0;
        p.answer = null;
      }
      this.state = 'countdown';
      this.phaseEnds = Date.now() + COUNTDOWN_MS;
      this.timer = setTimeout(() => this.nextQuestion(), COUNTDOWN_MS);
      this.broadcast();
    }

    nextQuestion() {
      this.clearTimer();
      this.qIndex++;
      if (this.qIndex >= this.questions.length) {
        this.state = 'final';
        this.phaseEnds = null;
        // chi è offline alla fine del round ha un po' di tempo per tornare, poi esce
        for (const p of this.players.values()) {
          if (!p.connected) p.leaveTimer = setTimeout(() => !p.connected && this.remove(p), LOBBY_GRACE_MS);
        }
        this.broadcast();
        return;
      }
      for (const p of this.players.values()) p.answer = null;
      this.state = 'question';
      this.qStart = Date.now();
      this.phaseEnds = this.qStart + QUESTION_TIME_MS;
      this.timer = setTimeout(() => this.reveal(), QUESTION_TIME_MS);
      this.broadcast();
    }

    answer(player, choice, qIndex, clientMs) {
      choice = Number(choice);
      if (this.state !== 'question' || Number(qIndex) !== this.qIndex || player.answer) return;
      if (!Number.isInteger(choice) || choice < 0 || choice >= this.questions[this.qIndex].options.length) return;
      // Il tempo misurato dall'host include la latenza di rete: usiamo quello misurato dal
      // giocatore, ma solo entro un margine di 2 secondi da quello dell'host.
      const hostMs = Date.now() - this.qStart;
      let ms = hostMs;
      if (Number.isFinite(clientMs)) ms = Math.min(hostMs, Math.max(hostMs - 2000, clientMs));
      player.answer = { choice, ms: Math.max(0, Math.round(ms)), points: null };
      this.broadcast();
      this.maybeEndQuestionEarly();
    }

    maybeEndQuestionEarly() {
      if (this.state !== 'question') return;
      const online = this.online();
      if (online.length > 0 && online.every((p) => p.answer)) {
        this.clearTimer();
        this.timer = setTimeout(() => this.reveal(), 600);
      }
    }

    reveal() {
      if (this.state !== 'question') return;
      this.clearTimer();
      const q = this.questions[this.qIndex];
      for (const p of this.players.values()) {
        if (!p.answer) continue;
        p.answer.points = p.answer.choice === q.correct ? pointsFor(p.answer.ms) : 0;
        p.score += p.answer.points;
        if (p.answer.points) p.correctCount++;
      }
      this.state = 'reveal';
      this.phaseEnds = Date.now() + REVEAL_TIME_MS;
      this.timer = setTimeout(() => this.nextQuestion(), REVEAL_TIME_MS);
      this.broadcast();
    }

    backToLobby() {
      this.clearTimer();
      this.state = 'lobby';
      this.phaseEnds = null;
      this.questions = [];
      this.qIndex = -1;
      for (const p of [...this.players.values()]) {
        if (!p.connected) this.players.delete(p.id);
      }
      for (const p of this.players.values()) {
        p.score = 0;
        p.correctCount = 0;
        p.answer = null;
      }
      this.broadcast();
    }

    close() {
      this.clearTimer();
      clearInterval(this.heartbeat);
      for (const p of this.players.values()) {
        if (p.conn) {
          p.conn.send({ t: 'closed' });
          const conn = p.conn;
          setTimeout(() => conn.close(), 300);
        }
      }
    }

    // ----- stato inviato ai giocatori -----
    ranking() {
      return [...this.players.values()]
        .map((p) => ({
          id: p.id,
          name: p.name,
          score: p.score,
          correctCount: p.correctCount,
          connected: p.connected,
          answered: !!p.answer,
          lastPoints: p.answer ? p.answer.points : null,
          lastMs: p.answer ? p.answer.ms : null,
          lastChoice: this.state === 'reveal' && p.answer ? p.answer.choice : null,
        }))
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    }

    viewFor(player, players) {
      const view = {
        room: this.code,
        state: this.state,
        you: player.id,
        hostId: this.hostId,
        maxPlayers: MAX_PLAYERS,
        total: QUESTIONS_PER_ROUND,
        questionTime: QUESTION_TIME_MS,
        remainingMs: this.phaseEnds ? Math.max(0, this.phaseEnds - Date.now()) : null,
        players,
      };
      if (this.state === 'question' || this.state === 'reveal') {
        const q = this.questions[this.qIndex];
        view.qIndex = this.qIndex;
        view.question = { text: q.q, options: q.options };
        view.yourAnswer = player.answer ? player.answer.choice : null;
        if (this.state === 'reveal') {
          view.question.correct = q.correct;
          view.yourPoints = player.answer ? player.answer.points : 0;
        }
      }
      return view;
    }

    broadcast() {
      const players = this.ranking();
      for (const p of this.players.values()) {
        if (p.send) p.send(this.viewFor(p, players));
      }
    }
  }

  // =====================================================================
  //  CLIENT: interfaccia
  // =====================================================================
  const $ = (id) => document.getElementById(id);
  const LETTERS = ['A', 'B', 'C', 'D', 'E'];
  const COLORS = ['#ff4d6d', '#3d8bfd', '#ffb020', '#2ecc71', '#b05cff', '#ff7ab6', '#4dd8e6', '#ffe066', '#a3e635', '#f97316'];
  const SESSION_KEY = 'domandone-session';

  let peer = null;      // il nostro Peer
  let hostGame = null;  // solo se siamo l'host
  let hostConn = null;  // solo se siamo un ospite
  let session = null;   // ospite: { room, name, token }
  let view = null;      // ultimo stato ricevuto
  let deadline = null;  // performance.now() di fine fase
  let questionShownAt = 0;
  let renderedKey = '';
  let celebrated = false;
  let pingTimer = null;
  let reconnect = null; // { tries, timer }
  let leaving = false;

  // ---------- sessione (per riconnettersi dopo un ricaricamento) ----------
  function saveSession(s) {
    session = s;
    try {
      if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {}
  }
  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
  }

  // ---------- creare una stanza (host) ----------
  async function createRoom(name) {
    setBusy(true, 'Creo la stanza…');
    try {
      let code;
      for (let attempt = 0; attempt < 5 && !peer; attempt++) {
        code = makeRoomCode();
        try {
          peer = await openPeer(PEER_PREFIX + code);
        } catch (err) {
          if (err.type !== 'unavailable-id') throw err;
        }
      }
      if (!peer) throw new Error('Impossibile creare la stanza, riprova.');
      hostGame = new HostGame(code);
      const me = hostGame.addPlayer(name, (v) => onState(v));
      hostGame.hostId = me.id;
      const game = hostGame;
      peer.on('connection', (conn) => game.attach(conn));
      keepSignaling(peer);
      history.replaceState(null, '', location.pathname);
      hostGame.broadcast();
    } catch (err) {
      resetNetwork();
      $('homeError').textContent = friendlyError(err);
    } finally {
      setBusy(false);
    }
  }

  // ---------- entrare in una stanza (ospite) ----------
  async function joinRoom(room, name, token) {
    setBusy(true, 'Mi collego alla stanza…');
    saveSession({ room, name, token: token || null });
    try {
      peer = await openPeer();
      keepSignaling(peer);
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') connectionLost(true);
      });
      connectToHost();
    } catch (err) {
      resetNetwork();
      saveSession(null);
      setBusy(false);
      $('homeError').textContent = friendlyError(err);
    }
  }

  // Se cade il collegamento al server di segnalazione, le connessioni già aperte restano attive:
  // ci ricolleghiamo per accettare nuovi giocatori o riconnessioni.
  function keepSignaling(p) {
    p.on('disconnected', () => { if (!p.destroyed && p === peer) p.reconnect(); });
  }

  function connectToHost() {
    if (hostConn) hostConn.close();
    const conn = peer.connect(PEER_PREFIX + session.room, { reliable: true, serialization: 'json' });
    hostConn = conn;
    const openTimeout = setTimeout(() => { if (!conn.open) connectionLost(true); }, 10000);
    conn.on('open', () => {
      clearTimeout(openTimeout);
      conn.send({ t: 'join', name: session.name, token: session.token });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => conn.open && conn.send({ t: 'ping' }), HEARTBEAT_MS);
    });
    conn.on('data', (msg) => {
      if (conn !== hostConn || !msg) return;
      if (msg.t === 'joined') {
        saveSession({ ...session, token: msg.token });
        reconnect = null;
        $('netStatus').classList.add('hidden');
        history.replaceState(null, '', `?room=${session.room}`);
      } else if (msg.t === 'state') {
        setBusy(false);
        onState(msg.view);
      } else if (msg.t === 'error') {
        leaving = true;
        goHome(msg.message);
      } else if (msg.t === 'closed') {
        leaving = true;
        goHome('L\'host ha chiuso la stanza.');
      }
    });
    conn.on('close', () => { if (conn === hostConn) connectionLost(false); });
    conn.on('error', () => { if (conn === hostConn) connectionLost(false); });
  }

  function connectionLost(hostMissing) {
    if (leaving || !session) return;
    clearInterval(pingTimer);
    // Mai entrati nella stanza: il codice è sbagliato o l'host non c'è più.
    if (!session.token) {
      goHome(hostMissing ? 'Stanza non trovata. Controlla il codice.' : 'Impossibile collegarsi alla stanza.');
      return;
    }
    if (!reconnect) reconnect = { tries: 0, timer: null };
    if (reconnect.timer) return;
    reconnect.tries++;
    if (reconnect.tries > 8) {
      goHome('Connessione con l\'host persa. La partita potrebbe essere terminata.');
      return;
    }
    $('netStatus').classList.remove('hidden');
    reconnect.timer = setTimeout(() => {
      reconnect.timer = null;
      if (!peer || peer.destroyed) return;
      connectToHost();
    }, 2500);
  }

  function resetNetwork() {
    clearInterval(pingTimer);
    if (reconnect && reconnect.timer) clearTimeout(reconnect.timer);
    reconnect = null;
    if (hostGame) hostGame.close();
    hostGame = null;
    if (hostConn) hostConn.close();
    hostConn = null;
    const p = peer;
    peer = null;
    if (p) setTimeout(() => p.destroy(), 400);
  }

  function goHome(msg) {
    resetNetwork();
    saveSession(null);
    view = null;
    renderedKey = '';
    setBusy(false);
    $('netStatus').classList.add('hidden');
    show('home');
    $('homeError').textContent = msg || '';
    leaving = false;
  }

  function friendlyError(err) {
    const type = err && err.type;
    if (type === 'browser-incompatible') return 'Questo browser non supporta le connessioni peer-to-peer (WebRTC).';
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      return 'Impossibile raggiungere il server di collegamento. Controlla la connessione a Internet.';
    }
    return (err && err.message) || 'Errore di connessione.';
  }

  // ---------- azioni del giocatore ----------
  function sendAction(msg) {
    if (hostGame) {
      const me = hostGame.players.get(hostGame.hostId);
      if (msg.t === 'answer') hostGame.answer(me, msg.choice, msg.qIndex, undefined);
    } else if (hostConn && hostConn.open) {
      hostConn.send(msg);
    }
  }

  function answer(i) {
    if (!view || view.state !== 'question' || view.yourAnswer != null) return;
    view.yourAnswer = i; // feedback immediato
    renderGame();
    sendAction({ t: 'answer', choice: i, qIndex: view.qIndex, ms: performance.now() - questionShownAt });
  }

  function leave() {
    if (hostGame && hostGame.players.size > 1 && !confirm('Sei l\'host: se esci la stanza verrà chiusa per tutti. Vuoi uscire?')) return;
    leaving = true;
    if (hostConn && hostConn.open) hostConn.send({ t: 'leave' });
    history.replaceState(null, '', location.pathname);
    goHome('');
  }

  // ---------- UI helper ----------
  function show(id) {
    for (const s of ['home', 'lobby', 'countdown', 'game', 'final']) $(s).classList.toggle('hidden', s !== id);
  }
  function setBusy(busy, text) {
    $('createBtn').disabled = busy;
    $('joinBtn').disabled = busy;
    $('homeInfo').textContent = busy ? text : '';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function colorFor(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }
  function avatar(p) {
    return `<div class="avatar" style="background:${colorFor(p.id)}">${esc(p.name[0].toUpperCase())}</div>`;
  }
  const me = () => view.players.find((p) => p.id === view.you);
  const isHost = () => view.hostId === view.you;

  // ---------- render ----------
  function onState(s) {
    const prevKey = view ? `${view.state}:${view.qIndex}` : '';
    view = s;
    deadline = s.remainingMs != null ? performance.now() + s.remainingMs : null;
    if (s.state === 'question' && prevKey !== `question:${s.qIndex}`) questionShownAt = performance.now();
    if (s.state !== 'final') celebrated = false;
    if (s.state === 'lobby') renderLobby();
    else if (s.state === 'countdown') show('countdown');
    else if (s.state === 'question' || s.state === 'reveal') renderGame();
    else if (s.state === 'final') renderFinal();
  }

  function renderLobby() {
    show('lobby');
    renderedKey = '';
    $('lobbyCode').textContent = view.room;
    $('shareLink').value = `${location.origin}${location.pathname}?room=${view.room}`;
    $('playerCount').textContent = `(${view.players.length}/${view.maxPlayers})`;
    $('lobbyPlayers').innerHTML = view.players.map((p) => `
      <div class="player ${p.connected ? '' : 'offline'}">
        ${avatar(p)}<div class="name">${esc(p.name)}</div>
        ${p.id === view.hostId ? '<span class="tag">HOST</span>' : p.id === view.you ? '<span class="tag you">TU</span>' : ''}
      </div>`).join('');
    $('startBtn').classList.toggle('hidden', !isHost());
    $('hostNote').classList.toggle('hidden', !isHost());
    $('waitHost').classList.toggle('hidden', isHost());
  }

  function renderGame() {
    show('game');
    const q = view.question;
    const key = `${view.room}:${view.qIndex}:${view.state}`;
    const isReveal = view.state === 'reveal';
    $('qCounter').textContent = `Domanda ${view.qIndex + 1}/${view.total}`;
    $('myScore').textContent = `${me().score} pt`;

    if (key !== renderedKey) {
      renderedKey = key;
      $('qText').textContent = q.text;
      $('answers').innerHTML = q.options.map((opt, i) => `
        <button class="answer" data-i="${i}"><span class="letter">${LETTERS[i]}</span><span>${esc(opt)}</span></button>`).join('');
      $('answers').querySelectorAll('.answer').forEach((btn) => btn.addEventListener('click', () => answer(Number(btn.dataset.i))));
    }

    const buttons = [...$('answers').querySelectorAll('.answer')];
    buttons.forEach((btn, i) => {
      btn.disabled = view.yourAnswer != null || isReveal;
      btn.classList.toggle('chosen', view.yourAnswer === i);
      btn.classList.toggle('dim', !isReveal && view.yourAnswer != null && view.yourAnswer !== i);
      btn.classList.toggle('correct', isReveal && q.correct === i);
      btn.classList.toggle('wrong', isReveal && q.correct !== i);
      btn.querySelector('.who')?.remove();
      if (isReveal) {
        const n = view.players.filter((p) => p.lastChoice === i).length;
        if (n) btn.insertAdjacentHTML('beforeend', `<span class="who">${n} 👤</span>`);
      }
    });

    const online = view.players.filter((p) => p.connected);
    const answered = online.filter((p) => p.answered).length;
    const banner = $('resultBanner');
    if (isReveal) {
      const ok = view.yourAnswer === q.correct;
      banner.className = `banner ${ok ? 'good' : 'bad'}`;
      banner.textContent = ok
        ? `Corretto! +${view.yourPoints} punti (${(me().lastMs / 1000).toFixed(2)}s)`
        : view.yourAnswer == null ? 'Tempo scaduto!' : 'Sbagliato!';
      const fastest = view.players.filter((p) => p.lastPoints > 0).sort((a, b) => a.lastMs - b.lastMs)[0];
      $('qStatus').textContent = fastest ? `⚡ Il più veloce: ${fastest.name} in ${(fastest.lastMs / 1000).toFixed(2)}s` : 'Nessuno ha indovinato!';
      $('revealBoard').classList.remove('hidden');
      renderBoard($('board'), true);
    } else {
      banner.className = 'banner hidden';
      $('revealBoard').classList.add('hidden');
      $('qStatus').textContent = view.yourAnswer != null
        ? `Risposta inviata! In attesa degli altri… (${answered}/${online.length})`
        : `${answered}/${online.length} hanno risposto`;
    }
  }

  function renderBoard(el, withDelta) {
    el.innerHTML = view.players.map((p, i) => `
      <div class="line ${p.id === view.you ? 'me' : ''}">
        <div class="pos">${i + 1}</div>
        <div class="who-cell">${avatar(p)}<span class="name">${esc(p.name)}${p.connected ? '' : ' <span class="muted">(offline)</span>'}</span></div>
        <div class="delta ${p.lastPoints ? '' : 'zero'}">${withDelta ? (p.lastPoints ? '+' + p.lastPoints : '+0') : p.correctCount + '/' + view.total + ' ✓'}</div>
        <div class="pts">${p.score}</div>
      </div>`).join('');
  }

  function renderFinal() {
    show('final');
    renderedKey = '';
    const [p1, p2, p3] = view.players;
    const tied = view.players.filter((p) => p.score === p1.score);
    $('winnerText').innerHTML = tied.length > 1
      ? `🏆 Pareggio tra <span>${tied.map((p) => esc(p.name)).join(', ')}</span>!`
      : `🏆 Vince <span>${esc(p1.name)}</span> con ${p1.score} punti!`;
    const step = (p, cls, n) => p
      ? `<div class="step ${cls}"><div class="pname">${esc(p.name)}</div><div class="pscore">${p.score} pt</div><div class="block">${n}</div></div>`
      : '<div></div>';
    $('podium').innerHTML = step(p2, 'p2', 2) + step(p1, 'p1', 1) + step(p3, 'p3', 3);
    renderBoard($('finalBoard'), false);
    $('againBtn').classList.toggle('hidden', !isHost());
    $('toLobbyBtn').classList.toggle('hidden', !isHost());
    $('finalWait').classList.toggle('hidden', isHost());
    if (!celebrated) {
      celebrated = true;
      confetti();
    }
  }

  function confetti() {
    for (let i = 0; i < 90; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = Math.random() * 100 + 'vw';
      c.style.background = COLORS[i % COLORS.length];
      c.style.animationDuration = 2.5 + Math.random() * 2.5 + 's';
      c.style.animationDelay = Math.random() * 1.2 + 's';
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 6500);
    }
  }

  // timer animato
  function tick() {
    if (view && deadline != null) {
      const left = Math.max(0, deadline - performance.now());
      if (view.state === 'question') {
        const ratio = left / view.questionTime;
        const bar = $('timerBar');
        bar.style.transform = `scaleX(${ratio})`;
        bar.style.backgroundPosition = `${ratio * 100}% 0`;
        $('qTime').textContent = Math.ceil(left / 1000) + 's';
      } else if (view.state === 'reveal') {
        $('timerBar').style.transform = 'scaleX(0)';
        $('qTime').textContent = view.qIndex + 1 < view.total ? `Prossima tra ${Math.ceil(left / 1000)}s` : 'Risultati…';
      } else if (view.state === 'countdown') {
        $('countNum').textContent = Math.max(1, Math.ceil(left / 1000));
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---------- eventi ----------
  function readName() {
    const name = cleanName($('nameInput').value);
    if (!name) { $('homeError').textContent = 'Inserisci un nickname.'; return null; }
    try { localStorage.setItem('domandone-name', name); } catch {}
    return name;
  }

  $('createBtn').onclick = () => {
    $('homeError').textContent = '';
    const name = readName();
    if (name) createRoom(name);
  };
  $('joinBtn').onclick = () => {
    $('homeError').textContent = '';
    const room = $('codeInput').value.trim().toUpperCase();
    const name = readName();
    if (!name) return;
    if (!/^[A-Z]{4}$/.test(room)) { $('homeError').textContent = 'Il codice stanza ha 4 lettere.'; return; }
    joinRoom(room, name, null);
  };
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ($('codeInput').value.trim() ? $('joinBtn') : $('createBtn')).click();
  });

  $('startBtn').onclick = () => hostGame && hostGame.start();
  $('againBtn').onclick = () => hostGame && hostGame.start();
  $('toLobbyBtn').onclick = () => hostGame && hostGame.backToLobby();
  $('leaveBtn').onclick = leave;
  $('leaveBtn2').onclick = leave;

  $('copyBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('shareLink').value);
      $('copyBtn').textContent = 'Copiato!';
    } catch {
      $('shareLink').select();
      $('copyBtn').textContent = 'Premi Ctrl+C';
    }
    setTimeout(() => ($('copyBtn').textContent = 'Copia link'), 1500);
  };

  // L'host è il "server": avvisa prima di chiudere la pagina durante una partita.
  window.addEventListener('beforeunload', (e) => {
    if (hostGame && hostGame.players.size > 1) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------- avvio ----------
  try { $('nameInput').value = localStorage.getItem('domandone-name') || ''; } catch {}
  const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (urlRoom) $('codeInput').value = urlRoom;
  const saved = loadSession();
  if (typeof Peer === 'undefined') {
    $('homeError').textContent = 'Impossibile caricare il gioco: libreria di rete mancante.';
  } else if (saved && saved.token && (!urlRoom || urlRoom === saved.room)) {
    // l'ospite ha ricaricato la pagina: rientra nella stanza
    joinRoom(saved.room, saved.name, saved.token);
  }
})();
