// Il Domandone — gioco multigiocatore.
// Il browser di chi crea la stanza (l'host) fa da "server": tiene lo stato della partita,
// i timer e i punteggi. I messaggi tra host e ospiti passano da un server ponte MQTT pubblico
// (WebSocket sicuro), così funziona da qualunque rete senza un server nostro.
(() => {
  // Immagini dei giocatori (public/avatars/<nome>.webp): ognuno ne ha una diversa,
  // quindi il numero massimo di giocatori è limitato anche dal numero di immagini.
  const AVATARS = ['pomodoro', 'arancia', 'broccolo', 'banana', 'anguria', 'carota', 'uva', 'mela', 'ananas'];
  const MAX_PLAYERS = Math.min(10, AVATARS.length);
  const QUESTIONS_PER_PLAYER = 5; // un round ha 5 domande per ogni giocatore
  const CATEGORIES_PER_PLAYER = 3;
  const FOOL_POINTS = 250; // punti all'autore della domanda bonus per ogni giocatore che sbaglia
  const QUESTION_TIME_MS = 20000;
  const REVEAL_TIME_MS = 6000;
  const COUNTDOWN_MS = 3000;
  const MAX_POINTS = 1000;
  const MIN_POINTS = 500; // punti per una risposta corretta data all'ultimo istante
  const LOBBY_GRACE_MS = 15000; // tempo per riconnettersi prima di essere rimossi dalla lobby
  const HEARTBEAT_MS = 3000;
  const HEARTBEAT_TIMEOUT_MS = 12000;
  const HOST_LOST_MS = 60000;
  const JOIN_TIMEOUT_MS = 9000;
  const TOPIC = 'il-domandone/v1/';
  // Server ponte pubblici e gratuiti; si possono sostituire (es. nei test) con window.DOMANDONE_BROKERS.
  const BROKERS = window.DOMANDONE_BROKERS || [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
  ];
  const NO_SERVER = 'Impossibile raggiungere il server di collegamento. Controlla la connessione a Internet.';

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
  function cleanText(text, max) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }
  // Valida le scelte di un giocatore: 3 categorie diverse e una domanda con 4 risposte, 1 giusta.
  function cleanSetup(data) {
    data = data && typeof data === 'object' ? data : {};
    const ids = window.CATEGORIES.map((c) => c.id);
    const cats = [...new Set(Array.isArray(data.cats) ? data.cats : [])].filter((c) => ids.includes(c)).slice(0, CATEGORIES_PER_PLAYER);
    let custom = null;
    const c = data.custom;
    if (c && typeof c === 'object' && Array.isArray(c.options)) {
      const q = cleanText(c.q, 160);
      const options = c.options.slice(0, 4).map((o) => cleanText(o, 60));
      const correct = Number(c.correct);
      const distinct = new Set(options.map((o) => o.toLowerCase())).size === 4;
      if (q && options.length === 4 && options.every(Boolean) && distinct && Number.isInteger(correct) && correct >= 0 && correct < 4) {
        custom = { q, options, correct };
      }
    }
    return { cats, custom };
  }
  function isReady(setup) {
    return !!setup && setup.cats.length === CATEGORIES_PER_PLAYER && !!setup.custom;
  }
  function weightedPick(weights) {
    const entries = Object.entries(weights).filter(([, w]) => w > 0);
    let r = Math.random() * entries.reduce((sum, [, w]) => sum + w, 0);
    for (const [key, w] of entries) {
      r -= w;
      if (r < 0) return key;
    }
    return entries[entries.length - 1][0];
  }

  function pointsFor(ms) {
    const ratio = Math.min(Math.max(ms / QUESTION_TIME_MS, 0), 1);
    return Math.round(MAX_POINTS - (MAX_POINTS - MIN_POINTS) * ratio);
  }
  function parse(payload) {
    try {
      const msg = JSON.parse(new TextDecoder().decode(payload));
      return msg && typeof msg === 'object' ? msg : null;
    } catch {
      return null;
    }
  }

  // Collegamento a un server ponte MQTT: si risolve alla prima connessione riuscita,
  // poi la libreria si ricollega da sola se la rete cade.
  function connectBroker(url) {
    return new Promise((resolve, reject) => {
      const client = mqtt.connect(url, {
        clientId: 'ild_' + makeId().replace(/-/g, ''),
        clean: true,
        keepalive: 30,
        connectTimeout: 8000,
        reconnectPeriod: 0, // al primo tentativo fallito passiamo oltre
      });
      client.on('error', () => {});
      const fail = () => { clearTimeout(timer); client.end(true); reject(new Error('unreachable')); };
      const timer = setTimeout(fail, 8000);
      client.once('close', fail);
      client.once('connect', () => {
        clearTimeout(timer);
        client.off('close', fail);
        client.options.reconnectPeriod = 2000; // da qui in poi si ricollega da solo
        resolve(client);
      });
    });
  }

  // Una "connessione" virtuale verso un ospite, identificato dal suo id sul server ponte.
  class RelayConn {
    constructor(client, topic, onClose) {
      this.client = client;
      this.topic = topic;
      this.onClose = onClose;
      this.open = true;
      this.handlers = {};
    }
    on(event, fn) {
      (this.handlers[event] ||= []).push(fn);
    }
    emit(event, arg) {
      for (const fn of this.handlers[event] || []) fn(arg);
    }
    send(msg) {
      if (this.open) this.client.publish(this.topic, JSON.stringify(msg));
    }
    close() {
      if (!this.open) return;
      this.open = false;
      this.onClose();
      this.emit('close');
    }
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
      this.roundCats = [];
      this.usedQuestions = new Set(); // domande già uscite in questa stanza ("categoria:indice")
      this.usedCustom = new Set();    // giocatori la cui domanda bonus è già uscita
      this.heartbeat = setInterval(() => this.checkHeartbeats(), 2000);
    }

    // Restituisce l'immagine richiesta se è libera, altrimenti la prima libera.
    freeAvatar(wanted, except) {
      const taken = new Set([...this.players.values()].filter((p) => p !== except).map((p) => p.avatar));
      wanted = Number(wanted);
      if (Number.isInteger(wanted) && wanted >= 0 && wanted < AVATARS.length && !taken.has(wanted)) return wanted;
      return AVATARS.findIndex((_, i) => !taken.has(i));
    }

    setAvatar(player, wanted) {
      if (this.state !== 'lobby' && this.state !== 'final') return;
      const avatar = this.freeAvatar(wanted, player);
      if (avatar !== Number(wanted)) return; // già presa da qualcun altro
      player.avatar = avatar;
      this.broadcast();
    }

    setSetup(player, data) {
      if (this.state !== 'lobby' && this.state !== 'final') return;
      player.setup = cleanSetup(data);
      this.broadcast();
    }

    addPlayer(name, send, avatar) {
      const player = {
        id: makeId(), token: makeId(), name, avatar: this.freeAvatar(avatar), setup: null, score: 0, correctCount: 0, answer: null,
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
    }

    onMessage(conn, msg) {
      if (!msg || typeof msg !== 'object') return;
      const player = conn.player;
      if (player) player.lastSeen = Date.now();
      if (msg.t === 'join') return this.onJoin(conn, msg);
      if (!player) {
        conn.send({ t: 'rejoin' }); // l'host non lo riconosce più: deve ripresentarsi
        return;
      }
      if (msg.t === 'answer') this.answer(player, msg.choice, msg.qIndex, msg.ms);
      else if (msg.t === 'avatar') this.setAvatar(player, msg.avatar);
      else if (msg.t === 'setup') this.setSetup(player, msg.setup);
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
      this.bind(this.addPlayer(name, null, msg.avatar), conn);
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
        if (p.conn) p.conn.send({ t: 'ping' });
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

    // Estrae 5 domande per giocatore: ogni categoria ha probabilità proporzionale
    // a quante volte è stata scelta dai giocatori. Alla fine aggiunge la domanda bonus di un giocatore.
    buildRound(participants) {
      const bank = window.QUESTIONS;
      const weights = {};
      for (const p of participants) {
        for (const c of (p.setup ? p.setup.cats : [])) weights[c] = (weights[c] || 0) + 1;
      }
      if (Object.keys(weights).length === 0) for (const c of Object.keys(bank)) weights[c] = 1;
      this.roundCats = Object.entries(weights).map(([id, count]) => ({ id, count }));

      const pickedNow = new Set();
      const poolFor = (cat) => {
        let pool = bank[cat].map((_, i) => `${cat}:${i}`).filter((k) => !this.usedQuestions.has(k) && !pickedNow.has(k));
        if (pool.length === 0) {
          // categoria esaurita: si ricomincia a pescare tra le sue domande già uscite in passato
          for (const k of [...this.usedQuestions]) if (k.startsWith(cat + ':')) this.usedQuestions.delete(k);
          pool = bank[cat].map((_, i) => `${cat}:${i}`).filter((k) => !pickedNow.has(k));
        }
        return pool;
      };

      const questions = [];
      const total = QUESTIONS_PER_PLAYER * participants.length;
      for (let n = 0; n < total; n++) {
        let available = Object.fromEntries(Object.entries(weights).filter(([c]) => poolFor(c).length > 0));
        if (Object.keys(available).length === 0) {
          available = Object.fromEntries(Object.keys(bank).filter((c) => poolFor(c).length > 0).map((c) => [c, 1]));
        }
        if (Object.keys(available).length === 0) break;
        const cat = weightedPick(available);
        const pool = poolFor(cat);
        const key = pool[randomInt(pool.length)];
        pickedNow.add(key);
        this.usedQuestions.add(key);
        const item = bank[cat][Number(key.split(':')[1])];
        const options = shuffle([item.a, ...item.w]);
        questions.push({ q: item.q, options, correct: options.indexOf(item.a), cat });
      }

      // domanda bonus scritta da uno dei giocatori, a rotazione
      const authors = participants.filter((p) => p.setup && p.setup.custom);
      let candidates = authors.filter((p) => !this.usedCustom.has(p.id));
      if (candidates.length === 0) {
        for (const p of authors) this.usedCustom.delete(p.id);
        candidates = authors;
      }
      if (candidates.length > 0) {
        const author = candidates[randomInt(candidates.length)];
        this.usedCustom.add(author.id);
        const c = author.setup.custom;
        const options = shuffle(c.options);
        questions.push({ q: c.q, options, correct: options.indexOf(c.options[c.correct]), cat: 'bonus', authorId: author.id, authorName: author.name });
      }
      return questions;
    }

    start() {
      if (this.state !== 'lobby' && this.state !== 'final') return;
      this.clearTimer();
      this.questions = this.buildRound(this.online());
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
      if (this.questions[this.qIndex].authorId === player.id) return; // l'autore non risponde alla sua domanda
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
      const authorId = this.questions[this.qIndex].authorId;
      const online = this.online().filter((p) => p.id !== authorId);
      if (online.length === 0 || online.every((p) => p.answer)) {
        this.clearTimer();
        this.timer = setTimeout(() => this.reveal(), 600);
      }
    }

    reveal() {
      if (this.state !== 'question') return;
      this.clearTimer();
      const q = this.questions[this.qIndex];
      let fooled = 0;
      for (const p of this.players.values()) {
        if (!p.answer) continue;
        p.answer.points = p.answer.choice === q.correct ? pointsFor(p.answer.ms) : 0;
        p.score += p.answer.points;
        if (p.answer.points) p.correctCount++;
        else fooled++;
      }
      // l'autore della domanda bonus guadagna punti per ogni giocatore che ha ingannato
      const author = q.authorId && this.players.get(q.authorId);
      if (author) {
        q.fooled = fooled;
        author.answer = { choice: null, ms: null, points: fooled * FOOL_POINTS };
        author.score += author.answer.points;
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
          avatar: p.avatar,
          score: p.score,
          correctCount: p.correctCount,
          connected: p.connected,
          ready: isReady(p.setup),
          answered: !!p.answer,
          lastPoints: p.answer ? p.answer.points : null,
          lastMs: p.answer ? p.answer.ms : null,
          lastChoice: this.state === 'reveal' && p.answer && p.answer.choice != null ? p.answer.choice : null,
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
        total: this.questions.length,
        hasBonus: this.questions.some((q) => q.authorId),
        roundCats: this.roundCats,
        yourSetup: player.setup,
        foolPoints: FOOL_POINTS,
        questionTime: QUESTION_TIME_MS,
        remainingMs: this.phaseEnds ? Math.max(0, this.phaseEnds - Date.now()) : null,
        players,
      };
      if (this.state === 'question' || this.state === 'reveal') {
        const q = this.questions[this.qIndex];
        view.qIndex = this.qIndex;
        view.question = { text: q.q, options: q.options, cat: q.cat, author: q.authorName || null };
        view.isAuthor = q.authorId === player.id;
        view.yourAnswer = player.answer ? player.answer.choice : null;
        if (this.state === 'reveal') {
          view.question.correct = q.correct;
          view.question.fooled = q.fooled || 0;
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

  let relay = null;     // collegamento MQTT al server ponte
  let hostGame = null;  // solo se siamo l'host
  let session = null;   // ospite: { room, name, token, cid, broker }
  let view = null;      // ultimo stato ricevuto
  let deadline = null;  // performance.now() di fine fase
  let questionShownAt = 0;
  let renderedKey = '';
  let celebrated = false;
  let pingTimer = null;
  let lastHostMsg = 0;
  let joinAttempt = null;
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
  async function createRoom(name, avatarIndex) {
    setBusy(true, 'Creo la stanza…');
    try {
      const client = await Promise.any(BROKERS.map(connectBroker)).catch(() => {
        throw new Error(NO_SERVER);
      });
      relay = { client };
      const code = makeRoomCode();
      const game = new HostGame(code);
      hostGame = game;
      const me = game.addPlayer(name, (v) => onState(v), avatarIndex);
      game.hostId = me.id;

      // Ogni ospite scrive sul topic dell'host e riceve sul proprio topic.
      const hostTopic = `${TOPIC}${code}/h`;
      const conns = new Map();
      client.on('message', (topic, payload) => {
        if (topic !== hostTopic) return;
        const msg = parse(payload);
        if (!msg || !/^[a-z0-9]{8,64}$/i.test(msg.from)) return;
        let conn = conns.get(msg.from);
        if (!conn) {
          conn = new RelayConn(client, `${TOPIC}${code}/c/${msg.from}`, () => conns.delete(msg.from));
          conns.set(msg.from, conn);
          game.attach(conn);
        }
        conn.emit('data', msg);
      });
      await new Promise((resolve, reject) => client.subscribe(hostTopic, (err) => (err ? reject(err) : resolve())));
      history.replaceState(null, '', location.pathname);
      game.broadcast();
    } catch (err) {
      resetNetwork();
      $('homeError').textContent = (err && err.message) || NO_SERVER;
    } finally {
      setBusy(false);
    }
  }

  // ---------- entrare in una stanza (ospite) ----------
  // Non sappiamo su quale server ponte si trova l'host: ci colleghiamo a tutti,
  // chiediamo di entrare e teniamo quello da cui l'host risponde.
  async function joinRoom(room, name, avatarIndex, token, broker, cid) {
    setBusy(true, 'Mi collego alla stanza…');
    cid = cid || makeId().replace(/-/g, '');
    saveSession({ room, name, avatar: avatarIndex, token: token || null, cid, broker: broker || null });
    const attempt = {};
    joinAttempt = attempt;
    const myTopic = `${TOPIC}${room}/c/${cid}`;
    const urls = broker ? [broker] : BROKERS;
    const clients = [];
    let winner = null;
    let failed = 0;

    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, JOIN_TIMEOUT_MS);
      urls.forEach((url) => connectBroker(url).then((client) => {
        if (winner || joinAttempt !== attempt) { client.end(true); return; }
        clients.push(client);
        client.on('message', (topic, payload) => {
          if (topic !== myTopic) return;
          const msg = parse(payload);
          if (!msg) return;
          if (!winner) {
            winner = { client, url };
            relay = { client };
            clearTimeout(timeout);
            resolve();
          }
          if (winner.client === client && joinAttempt === attempt) onHostMessage(msg);
        });
        client.subscribe(myTopic, (err) => {
          if (!err) client.publish(`${TOPIC}${room}/h`, JSON.stringify({ t: 'join', from: cid, name, avatar: avatarIndex, token: token || null }));
        });
      }).catch(() => {
        if (++failed === urls.length) { clearTimeout(timeout); resolve(); }
      }));
    });

    for (const c of clients) if (!winner || c !== winner.client || joinAttempt !== attempt) c.end(true);
    if (joinAttempt !== attempt) return; // nel frattempo siamo tornati alla home
    if (!winner) {
      goHome(failed === urls.length ? NO_SERVER
        : token ? 'L\'host non risponde: la partita potrebbe essere terminata.'
        : 'Stanza non trovata. Controlla il codice e che l\'host abbia la pagina aperta.');
      return;
    }
    saveSession({ ...session, broker: winner.url });
    lastHostMsg = Date.now();
    clearInterval(pingTimer);
    pingTimer = setInterval(guestHeartbeat, HEARTBEAT_MS);
  }

  function sendToHost(msg) {
    if (relay && session) {
      relay.client.publish(`${TOPIC}${session.room}/h`, JSON.stringify({ ...msg, from: session.cid }));
    }
  }

  function onHostMessage(msg) {
    lastHostMsg = Date.now();
    $('netStatus').classList.add('hidden');
    if (msg.t === 'joined') {
      saveSession({ ...session, token: msg.token });
      history.replaceState(null, '', `?room=${session.room}`);
    } else if (msg.t === 'state') {
      setBusy(false);
      onState(msg.view);
    } else if (msg.t === 'rejoin') {
      sendToHost({ t: 'join', name: session.name, avatar: session.avatar, token: session.token });
    } else if (msg.t === 'error') {
      leaving = true;
      goHome(msg.message);
    } else if (msg.t === 'closed') {
      leaving = true;
      goHome('L\'host ha chiuso la stanza.');
    }
  }

  // L'ospite manda un segnale ogni pochi secondi; se l'host tace troppo a lungo riprova a entrare.
  function guestHeartbeat() {
    if (!session || leaving) return;
    const silent = Date.now() - lastHostMsg;
    if (silent > HOST_LOST_MS) {
      goHome('Connessione con l\'host persa. La partita potrebbe essere terminata.');
    } else if (silent > HEARTBEAT_TIMEOUT_MS) {
      $('netStatus').classList.remove('hidden');
      sendToHost({ t: 'join', name: session.name, avatar: session.avatar, token: session.token });
    } else {
      sendToHost({ t: 'ping' });
    }
  }

  function resetNetwork() {
    clearInterval(pingTimer);
    pingTimer = null;
    joinAttempt = null;
    if (hostGame) hostGame.close();
    hostGame = null;
    const r = relay;
    relay = null;
    if (r) setTimeout(() => r.client.end(), 400);
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

  // ---------- azioni del giocatore ----------
  function sendAction(msg) {
    if (hostGame) {
      const me = hostGame.players.get(hostGame.hostId);
      if (msg.t === 'answer') hostGame.answer(me, msg.choice, msg.qIndex, undefined);
      else if (msg.t === 'avatar') hostGame.setAvatar(me, msg.avatar);
      else if (msg.t === 'setup') hostGame.setSetup(me, msg.setup);
    } else {
      sendToHost(msg);
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
    if (!hostGame) sendToHost({ t: 'leave' });
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
  function avatarUrl(i) {
    return `avatars/${AVATARS[i] || AVATARS[0]}.webp`;
  }
  function avatar(p, cls = '') {
    return `<img class="avatar ${cls}" src="${avatarUrl(p.avatar)}" alt="">`;
  }

  // Selettore immagini: in home sceglie la preferita, in lobby mostra quelle già prese.
  function renderAvatarPicker(el, selected, takenBy) {
    el.innerHTML = AVATARS.map((name, i) => {
      const owner = takenBy && takenBy.get(i);
      return `<button type="button" class="av-opt ${i === selected ? 'selected' : ''}" data-i="${i}"
        ${owner ? 'disabled' : ''} title="${owner ? 'Già scelta da ' + esc(owner) : name}" aria-label="${name}">
        <img src="${avatarUrl(i)}" alt=""></button>`;
    }).join('');
  }
  function loadAvatarChoice() {
    try {
      const i = Number(localStorage.getItem('domandone-avatar'));
      return Number.isInteger(i) && i >= 0 && i < AVATARS.length ? i : 0;
    } catch {
      return 0;
    }
  }
  function saveAvatarChoice(i) {
    try { localStorage.setItem('domandone-avatar', String(i)); } catch {}
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
    else if (s.state === 'countdown') renderCountdown();
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
        ${avatar(p)}<div class="name">${esc(p.name)}<div class="ready ${p.ready ? 'ok' : ''}">${p.ready ? '✓ Pronto' : '⏳ Si prepara…'}</div></div>
        ${p.id === view.hostId ? '<span class="tag">HOST</span>' : p.id === view.you ? '<span class="tag you">TU</span>' : ''}
      </div>`).join('');
    renderSetupStatus();
    const online = view.players.filter((p) => p.connected);
    const ready = online.filter((p) => p.ready).length;
    $('startBtn').textContent = `Inizia la partita! (${ready}/${online.length} pronti)`;
    const takenBy = new Map(view.players.filter((p) => p.id !== view.you).map((p) => [p.avatar, p.name]));
    renderAvatarPicker($('lobbyAvatars'), me().avatar, takenBy);
    $('startBtn').classList.toggle('hidden', !isHost());
    $('hostNote').classList.toggle('hidden', !isHost());
    $('waitHost').classList.toggle('hidden', isHost());
  }

  function catInfo(id) {
    return window.CATEGORIES.find((c) => c.id === id) || { label: id, emoji: '❓' };
  }

  function renderCountdown() {
    show('countdown');
    const totalPicks = view.roundCats.reduce((sum, c) => sum + c.count, 0);
    $('roundInfo').innerHTML = `<div>Round da <b>${view.total}</b> domande${view.hasBonus ? ' (l\'ultima è la domanda bonus di un giocatore!)' : ''}</div>
      <div class="cat-mix">${view.roundCats.slice().sort((a, b) => b.count - a.count).map((c) => {
        const info = catInfo(c.id);
        return `<span class="chip on">${info.emoji} ${esc(info.label)} · ${Math.round((c.count / totalPicks) * 100)}%</span>`;
      }).join('')}</div>`;
  }

  function renderGame() {
    show('game');
    const q = view.question;
    const key = `${view.room}:${view.qIndex}:${view.state}`;
    const isReveal = view.state === 'reveal';
    const isBonus = q.cat === 'bonus';
    $('qCounter').textContent = isBonus ? '⭐ Domanda bonus' : `Domanda ${view.qIndex + 1}/${view.total}`;
    $('myScore').innerHTML = `${avatar(me(), 'small')}<span>${me().score} pt</span>`;

    if (key !== renderedKey) {
      renderedKey = key;
      $('qText').textContent = q.text;
      const info = catInfo(q.cat);
      $('qCat').className = `q-cat ${isBonus ? 'bonus' : ''}`;
      $('qCat').textContent = isBonus ? `⭐ La domanda di ${q.author}` : `${info.emoji} ${info.label}`;
      $('answers').innerHTML = q.options.map((opt, i) => `
        <button class="answer" data-i="${i}"><span class="letter">${LETTERS[i]}</span><span>${esc(opt)}</span></button>`).join('');
      $('answers').querySelectorAll('.answer').forEach((btn) => btn.addEventListener('click', () => answer(Number(btn.dataset.i))));
    }

    const buttons = [...$('answers').querySelectorAll('.answer')];
    buttons.forEach((btn, i) => {
      btn.disabled = view.yourAnswer != null || isReveal || view.isAuthor;
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

    const online = view.players.filter((p) => p.connected && !(isBonus && p.name === q.author));
    const answered = online.filter((p) => p.answered).length;
    const banner = $('resultBanner');
    if (isReveal) {
      if (view.isAuthor) {
        const n = q.fooled;
        banner.className = `banner ${n ? 'good' : 'bad'}`;
        banner.textContent = n
          ? `Hai ingannato ${n} giocator${n === 1 ? 'e' : 'i'}: +${view.yourPoints} punti!`
          : 'Nessuno ci è cascato!';
      } else {
        const ok = view.yourAnswer === q.correct;
        banner.className = `banner ${ok ? 'good' : 'bad'}`;
        banner.textContent = ok
          ? `Corretto! +${view.yourPoints} punti (${(me().lastMs / 1000).toFixed(2)}s)`
          : view.yourAnswer == null ? 'Tempo scaduto!' : 'Sbagliato!';
      }
      const fastest = view.players.filter((p) => p.lastPoints > 0 && p.lastMs != null).sort((a, b) => a.lastMs - b.lastMs)[0];
      const author = isBonus ? ` · ${q.author} ha ingannato ${q.fooled} giocator${q.fooled === 1 ? 'e' : 'i'}` : '';
      $('qStatus').textContent = (fastest ? `⚡ Il più veloce: ${fastest.name} in ${(fastest.lastMs / 1000).toFixed(2)}s` : 'Nessuno ha indovinato!') + author;
      $('revealBoard').classList.remove('hidden');
      renderBoard($('board'), true);
    } else {
      banner.className = 'banner hidden';
      $('revealBoard').classList.add('hidden');
      $('qStatus').textContent = view.isAuthor
        ? `È la tua domanda! Guadagni ${view.foolPoints} punti per ogni giocatore che sbaglia. (${answered}/${online.length} hanno risposto)`
        : view.yourAnswer != null
          ? `Risposta inviata! In attesa degli altri… (${answered}/${online.length})`
          : `${answered}/${online.length} hanno risposto`;
    }
  }

  function renderBoard(el, withDelta) {
    el.innerHTML = view.players.map((p, i) => `
      <div class="line ${p.id === view.you ? 'me' : ''}">
        <div class="pos">${i + 1}</div>
        <div class="who-cell">${avatar(p)}<span class="name">${esc(p.name)}${p.connected ? '' : ' <span class="muted">(offline)</span>'}</span></div>
        <div class="delta ${p.lastPoints ? '' : 'zero'}">${withDelta ? (p.lastPoints ? '+' + p.lastPoints : '+0') : p.correctCount + ' ✓'}</div>
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
      ? `<div class="step ${cls}">${avatar(p, 'podium-av')}<div class="pname">${esc(p.name)}</div><div class="pscore">${p.score} pt</div><div class="block">${n}</div></div>`
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

  // ---------- preparazione: categorie e domanda personale ----------
  const SETUP_KEY = 'domandone-setup';
  let draft = { cats: [], custom: { q: '', options: ['', '', '', ''], correct: 0 } };
  try {
    const savedDraft = JSON.parse(localStorage.getItem(SETUP_KEY));
    if (savedDraft && savedDraft.custom && Array.isArray(savedDraft.cats) && Array.isArray(savedDraft.custom.options)) {
      draft = savedDraft;
      draft.cats = draft.cats.filter((id) => window.CATEGORIES.some((c) => c.id === id)).slice(0, CATEGORIES_PER_PLAYER);
    }
  } catch {}

  function saveDraft() {
    try { localStorage.setItem(SETUP_KEY, JSON.stringify(draft)); } catch {}
  }

  function renderCatPicker() {
    $('catPicker').innerHTML = window.CATEGORIES.map((c) => `
      <button type="button" class="chip ${draft.cats.includes(c.id) ? 'on' : ''}" data-id="${c.id}">${c.emoji} ${esc(c.label)}</button>`).join('');
    $('catCount').textContent = `${draft.cats.length}/${CATEGORIES_PER_PLAYER}`;
  }

  function fillSetupForm() {
    renderCatPicker();
    $('customQ').value = draft.custom.q;
    for (let i = 0; i < 4; i++) {
      $('customA' + i).value = draft.custom.options[i] || '';
      $('customC' + i).checked = draft.custom.correct === i;
    }
  }

  function readSetupForm() {
    draft.custom.q = $('customQ').value;
    draft.custom.options = [0, 1, 2, 3].map((i) => $('customA' + i).value);
    draft.custom.correct = [0, 1, 2, 3].find((i) => $('customC' + i).checked) ?? 0;
    saveDraft();
  }

  function setupProblem() {
    if (draft.cats.length !== CATEGORIES_PER_PLAYER) return `Scegli ${CATEGORIES_PER_PLAYER} categorie.`;
    const clean = cleanSetup(draft);
    if (!cleanText(draft.custom.q, 160)) return 'Scrivi la tua domanda.';
    if (draft.custom.options.some((o) => !cleanText(o, 60))) return 'Scrivi tutte e 4 le risposte.';
    if (!clean.custom) return 'Le 4 risposte devono essere diverse tra loro.';
    return null;
  }

  function sameSetup(a, b) {
    return !!a && !!b && JSON.stringify(cleanSetup(a)) === JSON.stringify(cleanSetup(b));
  }

  function renderSetupStatus() {
    if (!view) return;
    const saved = view.yourSetup;
    const ready = isReady(saved);
    const synced = ready && sameSetup(saved, draft);
    $('readyBtn').textContent = ready ? (synced ? '✓ Sei pronto!' : 'Salva le modifiche') : 'Sono pronto!';
    $('readyBtn').classList.toggle('ghost', synced);
    $('setupStatus').textContent = ready && !synced ? 'Hai modifiche non salvate.' : '';
  }

  $('catPicker').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const id = btn.dataset.id;
    if (draft.cats.includes(id)) draft.cats = draft.cats.filter((c) => c !== id);
    else if (draft.cats.length < CATEGORIES_PER_PLAYER) draft.cats.push(id);
    else {
      $('setupStatus').textContent = `Puoi scegliere al massimo ${CATEGORIES_PER_PLAYER} categorie: togline una prima.`;
      return;
    }
    saveDraft();
    renderCatPicker();
    renderSetupStatus();
  });
  $('setupForm').addEventListener('input', () => { readSetupForm(); renderSetupStatus(); });
  $('readyBtn').onclick = () => {
    readSetupForm();
    const problem = setupProblem();
    if (problem) { $('setupStatus').textContent = problem; return; }
    sendAction({ t: 'setup', setup: cleanSetup(draft) });
  };
  fillSetupForm();

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
    if (name) createRoom(name, homeAvatar);
  };
  $('joinBtn').onclick = () => {
    $('homeError').textContent = '';
    const room = $('codeInput').value.trim().toUpperCase();
    const name = readName();
    if (!name) return;
    if (!/^[A-Z]{4}$/.test(room)) { $('homeError').textContent = 'Il codice stanza ha 4 lettere.'; return; }
    joinRoom(room, name, homeAvatar, null);
  };
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ($('codeInput').value.trim() ? $('joinBtn') : $('createBtn')).click();
  });

  let homeAvatar = loadAvatarChoice();
  renderAvatarPicker($('homeAvatars'), homeAvatar, null);
  $('homeAvatars').addEventListener('click', (e) => {
    const btn = e.target.closest('.av-opt');
    if (!btn) return;
    homeAvatar = Number(btn.dataset.i);
    saveAvatarChoice(homeAvatar);
    renderAvatarPicker($('homeAvatars'), homeAvatar, null);
  });
  $('lobbyAvatars').addEventListener('click', (e) => {
    const btn = e.target.closest('.av-opt');
    if (!btn || btn.disabled || !view) return;
    const i = Number(btn.dataset.i);
    homeAvatar = i;
    saveAvatarChoice(i);
    renderAvatarPicker($('homeAvatars'), i, null);
    if (session) saveSession({ ...session, avatar: i });
    sendAction({ t: 'avatar', avatar: i });
  });

  $('startBtn').onclick = () => {
    if (!hostGame) return;
    const online = hostGame.online();
    const notReady = online.filter((p) => !isReady(p.setup)).map((p) => p.name);
    if (notReady.length && !confirm(`Non sono ancora pronti: ${notReady.join(', ')}.\nIniziare comunque? Le loro categorie e domande non verranno usate.`)) return;
    hostGame.start();
  };
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
  if (typeof mqtt === 'undefined') {
    $('homeError').textContent = 'Impossibile caricare il gioco: libreria di rete mancante.';
  } else if (saved && saved.token && (!urlRoom || urlRoom === saved.room)) {
    // l'ospite ha ricaricato la pagina: rientra nella stanza
    joinRoom(saved.room, saved.name, saved.avatar, saved.token, saved.broker, saved.cid);
  }
})();
