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
  const BOOST_WEIGHT = 3; // la categoria favorita esce circa 3 volte più spesso delle altre
  const FOOL_POINTS = 250; // punti all'autore della domanda bonus per ogni giocatore che sbaglia
  // Solo nella versione Plus:
  const DRAW_POINTS = 250; // punti all'autore di un disegno per ogni giocatore che indovina
  const GUESS_BONUS = 200; // bonus a chi indovina una domanda o un disegno di un giocatore
  const DRAW_PROMPT = 'Che cosa rappresenta il disegno?';
  const DRAW_MAX_POINTS = 4000; // limite di punti per disegno, per tenere piccoli i messaggi
  const QUESTION_TIME_MS = 20000;
  const REVEAL_TIME_MS = 6000;
  const COUNTDOWN_MS = 3000;
  const MAX_POINTS = 750; // punti per una risposta corretta immediata: la rapidità vale al massimo 250 punti
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
  // Un disegno è una lista di tratti; ogni tratto è [x0, y0, x1, y1, ...] con coordinate intere 0-1000.
  function cleanDrawing(strokes) {
    if (!Array.isArray(strokes)) return null;
    const out = [];
    let points = 0;
    for (const st of strokes.slice(0, 400)) {
      if (!Array.isArray(st) || st.length < 2) continue;
      const room = (DRAW_MAX_POINTS - points) * 2;
      if (room <= 0) break;
      const clean = st.slice(0, Math.min(st.length - (st.length % 2), room))
        .map((v) => Math.max(0, Math.min(1000, Math.round(Number(v) || 0))));
      if (clean.length < 2) continue;
      out.push(clean);
      points += clean.length / 2;
    }
    return out.length ? out : null;
  }

  // Valida il contributo di un giocatore: una domanda (o, nel Plus, un disegno) con 4 risposte
  // diverse, di cui 1 giusta.
  function cleanSetup(data, mode) {
    data = data && typeof data === 'object' ? data : {};
    let custom = null;
    const c = data.custom;
    if (c && typeof c === 'object' && Array.isArray(c.options)) {
      const kind = mode === 'plus' && c.kind === 'drawing' ? 'drawing' : 'question';
      const drawing = kind === 'drawing' ? cleanDrawing(c.drawing) : null;
      const q = kind === 'drawing' ? DRAW_PROMPT : cleanText(c.q, 160);
      const options = c.options.slice(0, 4).map((o) => cleanText(o, 60));
      const correct = Number(c.correct);
      const distinct = new Set(options.map((o) => o.toLowerCase())).size === 4;
      if (q && (kind === 'question' || drawing) && options.length === 4 && options.every(Boolean) && distinct
        && Number.isInteger(correct) && correct >= 0 && correct < 4) {
        custom = { kind, q, options, correct };
        if (drawing) custom.drawing = drawing;
      }
    }
    return { custom };
  }
  function isReady(setup) {
    return !!setup && !!setup.custom;
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
    constructor(code, mode) {
      this.code = code;
      this.mode = mode === 'plus' ? 'plus' : 'classic';
      this.players = new Map();
      this.hostId = null;
      this.state = 'lobby';
      this.questions = [];
      this.qIndex = -1;
      this.qStart = 0;
      this.phaseEnds = null;
      this.timer = null;
      this.roundBoost = null; // categoria favorita del round in corso: { cat, by }
      this.boostCat = null;   // categoria favorita scelta per il prossimo round
      this.pickerId = null;   // chi ha fatto meno punti nell'ultimo round e può sceglierla
      this.pickerName = null;
      this.usedQuestions = new Set(); // domande già uscite in questa stanza ("categoria:indice")
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

    setBoost(player, cat) {
      if (this.state !== 'lobby' && this.state !== 'final') return;
      if (player.id !== this.pickerId || !window.CATEGORIES.some((c) => c.id === cat)) return;
      this.boostCat = cat;
      this.broadcast();
    }

    setSetup(player, data) {
      if (this.state !== 'lobby' && this.state !== 'final') return;
      player.setup = cleanSetup(data, this.mode);
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
      else if (msg.t === 'boost') this.setBoost(player, msg.cat);
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

    // Estrae 5 domande per giocatore: tutte le categorie hanno la stessa probabilità, tranne quella
    // favorita (scelta da chi ha fatto meno punti nel round precedente), che esce più spesso.
    // Dopo ogni 5 domande inserisce quella scritta da un giocatore.
    buildRound(participants) {
      const bank = window.QUESTIONS;
      const weights = {};
      for (const c of Object.keys(bank)) weights[c] = 1;
      this.roundBoost = null;
      if (this.boostCat && weights[this.boostCat]) {
        weights[this.boostCat] = BOOST_WEIGHT;
        this.roundBoost = { cat: this.boostCat, by: this.pickerName };
      }
      this.boostCat = null;
      this.pickerId = null;
      this.pickerName = null;

      // una domanda generata dalla banca e usata da un giocatore non esce due volte nello stesso round
      const customTexts = new Set(participants.filter((p) => p.setup && p.setup.custom).map((p) => p.setup.custom.q.toLowerCase()));
      const free = (cat) => bank[cat].map((item, i) => ({ item, key: `${cat}:${i}` }))
        .filter(({ item, key }) => !pickedNow.has(key) && !customTexts.has(item.q.toLowerCase())).map(({ key }) => key);
      const pickedNow = new Set();
      const poolFor = (cat) => {
        let pool = free(cat).filter((k) => !this.usedQuestions.has(k));
        if (pool.length === 0) {
          // categoria esaurita: si ricomincia a pescare tra le sue domande già uscite in passato
          for (const k of [...this.usedQuestions]) if (k.startsWith(cat + ':')) this.usedQuestions.delete(k);
          pool = free(cat);
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

      // le domande scritte dai giocatori escono tutte, una dopo ogni blocco di 5 domande
      const customs = shuffle(participants.filter((p) => p.setup && p.setup.custom)).map((author) => {
        const c = author.setup.custom;
        const options = shuffle(c.options);
        return {
          q: c.q, options, correct: options.indexOf(c.options[c.correct]), cat: 'bonus',
          kind: c.kind || 'question', drawing: c.drawing || null, authorId: author.id, authorName: author.name,
        };
      });
      const round = [];
      questions.forEach((q, i) => {
        round.push(q);
        if ((i + 1) % QUESTIONS_PER_PLAYER === 0 && customs.length) round.push(customs.shift());
      });
      return round.concat(customs);
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
        // chi ha fatto meno punti sceglie la categoria favorita del prossimo round
        const online = this.online();
        const min = Math.min(...online.map((p) => p.score));
        const last = online.filter((p) => p.score === min);
        const picker = last.length ? last[randomInt(last.length)] : null;
        this.pickerId = picker ? picker.id : null;
        this.pickerName = picker ? picker.name : null;
        this.boostCat = null;
        // a ogni round i giocatori scrivono una domanda nuova
        for (const p of this.players.values()) p.setup = null;
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
      let guessed = 0;
      for (const p of this.players.values()) {
        if (!p.answer) continue;
        const ok = p.answer.choice === q.correct;
        // nel Plus chi indovina la domanda o il disegno di un giocatore prende anche un bonus
        p.answer.bonus = ok && q.authorId && this.mode === 'plus' ? GUESS_BONUS : 0;
        p.answer.points = ok ? pointsFor(p.answer.ms) + p.answer.bonus : 0;
        p.score += p.answer.points;
        if (ok) { p.correctCount++; guessed++; } else fooled++;
      }
      // l'autore di una domanda guadagna punti per ogni giocatore ingannato,
      // l'autore di un disegno per ogni giocatore che lo ha indovinato
      const author = q.authorId && this.players.get(q.authorId);
      if (author) {
        q.fooled = fooled;
        q.guessed = guessed;
        const points = q.kind === 'drawing' ? guessed * DRAW_POINTS : fooled * FOOL_POINTS;
        author.answer = { choice: null, ms: null, points };
        author.score += points;
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
        mode: this.mode,
        state: this.state,
        you: player.id,
        hostId: this.hostId,
        maxPlayers: MAX_PLAYERS,
        total: this.questions.length,
        bonusCount: this.questions.filter((q) => q.authorId).length,
        roundBoost: this.roundBoost,
        boostCat: this.boostCat,
        pickerId: this.pickerId,
        pickerName: this.pickerName,
        yourSetup: player.setup,
        foolPoints: FOOL_POINTS,
        drawPoints: DRAW_POINTS,
        guessBonus: GUESS_BONUS,
        questionTime: QUESTION_TIME_MS,
        remainingMs: this.phaseEnds ? Math.max(0, this.phaseEnds - Date.now()) : null,
        players,
      };
      if (this.state === 'question' || this.state === 'reveal') {
        const q = this.questions[this.qIndex];
        view.qIndex = this.qIndex;
        view.question = { text: q.q, options: q.options, cat: q.cat, author: q.authorName || null, kind: q.kind || 'question' };
        if (q.kind === 'drawing') view.question.drawing = q.drawing;
        view.isAuthor = q.authorId === player.id;
        view.yourAnswer = player.answer ? player.answer.choice : null;
        if (this.state === 'reveal') {
          view.question.correct = q.correct;
          view.question.fooled = q.fooled || 0;
          view.question.guessed = q.guessed || 0;
          view.yourPoints = player.answer ? player.answer.points : 0;
          view.yourBonus = player.answer ? player.answer.bonus || 0 : 0;
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
  async function createRoom(name, avatarIndex, mode) {
    setBusy(true, 'Creo la stanza…');
    try {
      const client = await Promise.any(BROKERS.map(connectBroker)).catch(() => {
        throw new Error(NO_SERVER);
      });
      relay = { client };
      const code = makeRoomCode();
      const game = new HostGame(code, mode);
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
      else if (msg.t === 'boost') hostGame.setBoost(me, msg.cat);
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
    $('createPlusBtn').disabled = busy;
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
    if (s.state === 'final' && !prevKey.startsWith('final')) clearSetupForm(); // nuovo round, nuova domanda
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
    const plus = view.mode === 'plus';
    $('modeBadge').textContent = plus ? 'Il Domandone Plus ✨' : 'Il Domandone · Classico';
    $('modeBadge').classList.toggle('plus', plus);
    document.title = plus ? 'Il Domandone Plus' : 'Il Domandone';
    $('kindTabs').classList.toggle('hidden', !plus);
    if (!plus && draft.custom.kind === 'drawing') setKind('question');
    $('shareLink').value = `${location.origin}${location.pathname}?room=${view.room}`;
    $('playerCount').textContent = `(${view.players.length}/${view.maxPlayers})`;
    $('lobbyPlayers').innerHTML = view.players.map((p) => `
      <div class="player ${p.connected ? '' : 'offline'}">
        ${avatar(p)}<div class="name">${esc(p.name)}<div class="ready ${p.ready ? 'ok' : ''}">${p.ready ? '✓ Pronto' : '⏳ Si prepara…'}</div></div>
        ${p.id === view.hostId ? '<span class="tag">HOST</span>' : p.id === view.you ? '<span class="tag you">TU</span>' : ''}
      </div>`).join('');
    syncSetupForm();
    renderSetupStatus();
    renderBoost($('boostLobby'));
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
    const regular = view.total - view.bonusCount;
    const boost = view.roundBoost;
    const info = boost && catInfo(boost.cat);
    $('roundInfo').innerHTML = `<div>Round da <b>${regular}</b> domande${view.bonusCount
      ? ` + <b>${view.bonusCount}</b> ${view.mode === 'plus'
        ? (view.bonusCount === 1 ? 'domanda o disegno di un giocatore' : 'domande o disegni dei giocatori')
        : (view.bonusCount === 1 ? 'domanda scritta da un giocatore' : 'domande scritte dai giocatori')}, una ogni ${QUESTIONS_PER_PLAYER}!` : ''}</div>
      ${boost ? `<div class="cat-mix"><span class="chip on">🎯 Categoria favorita: ${info.emoji} ${esc(info.label)}${boost.by ? ' · scelta da ' + esc(boost.by) : ''}</span></div>` : ''}`;
  }

  function renderGame() {
    show('game');
    const q = view.question;
    const key = `${view.room}:${view.qIndex}:${view.state}`;
    const isReveal = view.state === 'reveal';
    const isBonus = q.cat === 'bonus';
    $('qCounter').textContent = `${isBonus ? '⭐ ' : ''}Domanda ${view.qIndex + 1}/${view.total}`;
    $('myScore').innerHTML = `${avatar(me(), 'small')}<span>${me().score} pt</span>`;

    const isDrawing = q.kind === 'drawing';
    if (key !== renderedKey) {
      renderedKey = key;
      $('qText').textContent = isDrawing ? `Che cosa ha disegnato ${q.author}?` : q.text;
      $('qDrawing').classList.toggle('hidden', !isDrawing);
      if (isDrawing) drawStrokes($('qDrawing'), q.drawing);
      const info = catInfo(q.cat);
      $('qCat').className = `q-cat ${isBonus ? 'bonus' : ''}`;
      $('qCat').textContent = isDrawing ? `✏️ Il disegno di ${q.author}` : isBonus ? `⭐ La domanda di ${q.author}` : `${info.emoji} ${info.label}`;
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
      const plural = (n) => `${n} giocator${n === 1 ? 'e' : 'i'}`;
      if (view.isAuthor && isDrawing) {
        const n = q.guessed;
        banner.className = `banner ${n ? 'good' : 'bad'}`;
        banner.textContent = n ? `Hanno indovinato in ${n}: +${view.yourPoints} punti!` : 'Nessuno ha indovinato il tuo disegno!';
      } else if (view.isAuthor) {
        const n = q.fooled;
        banner.className = `banner ${n ? 'good' : 'bad'}`;
        banner.textContent = n
          ? `Hai ingannato ${plural(n)}: +${view.yourPoints} punti!`
          : 'Nessuno ci è cascato!';
      } else {
        const ok = view.yourAnswer === q.correct;
        banner.className = `banner ${ok ? 'good' : 'bad'}`;
        banner.textContent = ok
          ? `Corretto! +${view.yourPoints} punti (${(me().lastMs / 1000).toFixed(2)}s)${view.yourBonus ? ` · bonus +${view.yourBonus} incluso` : ''}`
          : view.yourAnswer == null ? 'Tempo scaduto!' : 'Sbagliato!';
      }
      const fastest = view.players.filter((p) => p.lastPoints > 0 && p.lastMs != null).sort((a, b) => a.lastMs - b.lastMs)[0];
      const author = isDrawing ? ` · ${plural(q.guessed)} ${q.guessed === 1 ? 'ha' : 'hanno'} indovinato il disegno di ${q.author}`
        : isBonus ? ` · ${q.author} ha ingannato ${plural(q.fooled)}` : '';
      $('qStatus').textContent = (fastest ? `⚡ Il più veloce: ${fastest.name} in ${(fastest.lastMs / 1000).toFixed(2)}s` : 'Nessuno ha indovinato!') + author;
      $('revealBoard').classList.remove('hidden');
      renderBoard($('board'), true);
    } else {
      banner.className = 'banner hidden';
      $('revealBoard').classList.add('hidden');
      $('qStatus').textContent = view.isAuthor
        ? (isDrawing
          ? `È il tuo disegno! Guadagni ${view.drawPoints} punti per ogni giocatore che indovina. (${answered}/${online.length} hanno risposto)`
          : `È la tua domanda! Guadagni ${view.foolPoints} punti per ogni giocatore che sbaglia. (${answered}/${online.length} hanno risposto)`)
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
    renderBoost($('boostFinal'));
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

  // ---------- preparazione: la domanda (o il disegno) del giocatore ----------
  const emptyDraft = () => ({ custom: { kind: 'question', q: '', options: ['', '', '', ''], correct: 0, drawing: [] } });
  let draft = emptyDraft();
  const currentMode = () => (view && view.mode) || 'classic';
  const draftIsEmpty = () => !draft.custom.q.trim() && draft.custom.options.every((o) => !o.trim()) && !draft.custom.drawing.length;

  // Cose da disegnare suggerite dal tasto "Genera", con risposte sbagliate simili.
  const DRAW_IDEAS = [
    ['Gatto', 'Tigre', 'Volpe', 'Cane'], ['Cane', 'Lupo', 'Gatto', 'Volpe'], ['Casa', 'Castello', 'Chiesa', 'Capanna'],
    ['Sole', 'Stella', 'Luna', 'Girasole'], ['Albero', 'Fiore', 'Cespuglio', 'Fungo'], ['Pesce', 'Balena', 'Delfino', 'Squalo'],
    ['Macchina', 'Camion', 'Autobus', 'Trattore'], ['Bicicletta', 'Moto', 'Monopattino', 'Carrozzina'], ['Aereo', 'Elicottero', 'Razzo', 'Aquilone'],
    ['Nave', 'Barca a vela', 'Sottomarino', 'Canoa'], ['Pizza', 'Torta', 'Crostata', 'Frittata'], ['Gelato', 'Cono stradale', 'Lecca-lecca', 'Microfono'],
    ['Ombrello', 'Fungo', 'Ventaglio', 'Lampada'], ['Occhiali', 'Bicicletta', 'Binocolo', 'Manubrio'], ['Chitarra', 'Violino', 'Ukulele', 'Mandolino'],
    ['Pallone da calcio', 'Pallone da basket', 'Pallina da tennis', 'Palla da bowling'], ['Cuore', 'Fragola', 'Mela', 'Ciliegia'],
    ['Fantasma', 'Lenzuolo', 'Nuvola', 'Medusa'], ['Serpente', 'Verme', 'Anguilla', 'Lombrico'], ['Farfalla', 'Libellula', 'Ape', 'Coccinella'],
    ['Montagna', 'Vulcano', 'Piramide', 'Collina'], ['Telefono', 'Telecomando', 'Calcolatrice', 'Tablet'], ['Orologio', 'Bussola', 'Sveglia', 'Ruota'],
    ['Chiave', 'Lucchetto', 'Cacciavite', 'Forchetta'], ['Corona', 'Cappello', 'Elmo', 'Tiara'], ['Razzo', 'Missile', 'Matita', 'Faro'],
    ['Banana', 'Luna', 'Peperone', 'Zucchina'], ['Lampadina', 'Pera', 'Palloncino', 'Torcia'], ['Bottiglia', 'Vaso', 'Bicchiere', 'Lattina'],
    ['Scarpa', 'Stivale', 'Calzino', 'Pattino'], ['Arcobaleno', 'Ponte', 'Arco', 'Altalena'], ['Fiocco di neve', 'Stella', 'Fiore', 'Ragno'],
    ['Pupazzo di neve', 'Fantasma', 'Orso polare', 'Pinguino'], ['Ragno', 'Polpo', 'Scarafaggio', 'Granchio'], ['Coniglio', 'Lepre', 'Topo', 'Canguro'],
    ['Elefante', 'Rinoceronte', 'Mammut', 'Ippopotamo'], ['Giraffa', 'Zebra', 'Cammello', 'Struzzo'], ['Uovo', 'Patata', 'Sasso', 'Limone'],
    ['Robot', 'Astronauta', 'Armatura', 'Frigorifero'], ['Torre Eiffel', 'Traliccio', 'Razzo', 'Faro'], ['Dinosauro', 'Drago', 'Lucertola', 'Coccodrillo'],
    ['Pinguino', 'Gabbiano', 'Papera', 'Gufo'], ['Tenda', 'Piramide', 'Triangolo', 'Montagna'], ['Candela', 'Accendino', 'Matita', 'Torcia'],
  ];

  function fillSetupForm() {
    const isDraw = draft.custom.kind === 'drawing';
    $('customQ').value = draft.custom.q;
    for (let i = 0; i < 4; i++) {
      $('customA' + i).value = draft.custom.options[i] || '';
      $('customC' + i).checked = draft.custom.correct === i;
    }
    $('questionBox').classList.toggle('hidden', isDraw);
    $('drawBox').classList.toggle('hidden', !isDraw);
    $('answersLabel').textContent = isDraw ? 'Che cosa hai disegnato? 4 risposte · segna quella giusta' : '4 risposte · segna quella giusta';
    for (const btn of $('kindTabs').querySelectorAll('.chip')) btn.classList.toggle('on', btn.dataset.kind === draft.custom.kind);
    drawStrokes($('drawCanvas'), draft.custom.drawing);
  }

  function readSetupForm() {
    draft.custom.q = $('customQ').value;
    draft.custom.options = [0, 1, 2, 3].map((i) => $('customA' + i).value);
    draft.custom.correct = [0, 1, 2, 3].find((i) => $('customC' + i).checked) ?? 0;
  }

  function setKind(kind) {
    readSetupForm();
    draft.custom.kind = kind === 'drawing' && currentMode() === 'plus' ? 'drawing' : 'question';
    fillSetupForm();
    $('setupStatus').textContent = '';
    renderSetupStatus();
  }

  // A ogni round si riparte con i campi vuoti.
  function clearSetupForm() {
    const kind = draft.custom.kind;
    draft = emptyDraft();
    draft.custom.kind = kind;
    fillSetupForm();
    $('setupStatus').textContent = '';
  }

  // Dopo un ricaricamento della pagina, recupera quanto già inviato all'host.
  function syncSetupForm() {
    const saved = view && view.yourSetup && view.yourSetup.custom;
    if (saved && draftIsEmpty()) {
      draft = { custom: {
        kind: saved.kind || 'question', q: saved.kind === 'drawing' ? '' : saved.q, options: saved.options.slice(),
        correct: saved.correct, drawing: saved.drawing ? saved.drawing.map((st) => st.slice()) : [],
      } };
      fillSetupForm();
    }
  }

  // Riempie i campi con una domanda a caso della banca (o, per il disegno, con cosa disegnare).
  function generateQuestion() {
    readSetupForm();
    if (draft.custom.kind === 'drawing') {
      let idea;
      do { idea = DRAW_IDEAS[randomInt(DRAW_IDEAS.length)]; } while (draft.custom.options.includes(idea[0]));
      const options = shuffle(idea);
      draft.custom.options = options;
      draft.custom.correct = options.indexOf(idea[0]);
      fillSetupForm();
      $('setupStatus').textContent = `Ora disegna: ${idea[0]}!`;
      renderSetupStatus();
      return;
    }
    const all = Object.values(window.QUESTIONS).flat();
    let item;
    do { item = all[randomInt(all.length)]; } while (all.length > 1 && item.q === draft.custom.q);
    const options = shuffle([item.a, ...item.w]);
    draft.custom = { kind: 'question', q: item.q, options, correct: options.indexOf(item.a), drawing: [] };
    fillSetupForm();
    $('setupStatus').textContent = '';
    renderSetupStatus();
  }

  function setupProblem() {
    const clean = cleanSetup(draft, currentMode());
    if (draft.custom.kind === 'drawing') {
      if (!draft.custom.drawing.length) return 'Fai un disegno nel riquadro.';
    } else if (!cleanText(draft.custom.q, 160)) {
      return 'Scrivi la tua domanda.';
    }
    if (draft.custom.options.some((o) => !cleanText(o, 60))) return 'Scrivi tutte e 4 le risposte.';
    if (!clean.custom) return 'Le 4 risposte devono essere diverse tra loro.';
    return null;
  }

  function sameSetup(a, b) {
    return !!a && !!b && JSON.stringify(cleanSetup(a, currentMode())) === JSON.stringify(cleanSetup(b, currentMode()));
  }

  function renderSetupStatus() {
    if (!view) return;
    const saved = view.yourSetup;
    const ready = isReady(saved);
    const synced = ready && sameSetup(saved, draft);
    $('readyBtn').textContent = ready ? (synced ? '✓ Sei pronto!' : 'Salva le modifiche') : 'Sono pronto!';
    $('readyBtn').classList.toggle('ghost', synced);
    if (ready) $('setupStatus').textContent = synced ? '' : 'Hai modifiche non salvate.';
  }

  // ---------- disegno: tratti salvati come coordinate 0-1000 ----------
  function drawStrokes(canvas, strokes) {
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#1a1235';
    ctx.lineWidth = size * 0.012;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const st of strokes || []) {
      ctx.beginPath();
      ctx.moveTo((st[0] * size) / 1000, (st[1] * size) / 1000);
      if (st.length === 2) ctx.lineTo((st[0] * size) / 1000 + 0.1, (st[1] * size) / 1000);
      for (let i = 2; i < st.length; i += 2) ctx.lineTo((st[i] * size) / 1000, (st[i + 1] * size) / 1000);
      ctx.stroke();
    }
  }

  (function setupDrawPad() {
    const canvas = $('drawCanvas');
    let current = null;
    const pointCount = () => draft.custom.drawing.reduce((n, st) => n + st.length / 2, 0);
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [Math.round(((e.clientX - r.left) / r.width) * 1000), Math.round(((e.clientY - r.top) / r.height) * 1000)]
        .map((v) => Math.max(0, Math.min(1000, v)));
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (pointCount() >= DRAW_MAX_POINTS) { $('setupStatus').textContent = 'Il disegno è troppo complesso: cancella qualcosa.'; return; }
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      current = pos(e);
      draft.custom.drawing.push(current);
      drawStrokes(canvas, draft.custom.drawing);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!current) return;
      const [x, y] = pos(e);
      const lx = current[current.length - 2];
      const ly = current[current.length - 1];
      if (Math.hypot(x - lx, y - ly) < 6 || pointCount() >= DRAW_MAX_POINTS) return; // salta i punti troppo vicini
      current.push(x, y);
      drawStrokes(canvas, draft.custom.drawing);
    });
    const end = () => {
      if (!current) return;
      current = null;
      renderSetupStatus();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    $('undoStrokeBtn').onclick = () => { draft.custom.drawing.pop(); drawStrokes(canvas, draft.custom.drawing); renderSetupStatus(); };
    $('clearDrawBtn').onclick = () => { draft.custom.drawing = []; drawStrokes(canvas, draft.custom.drawing); renderSetupStatus(); };
  })();

  $('kindTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (btn) setKind(btn.dataset.kind);
  });
  $('setupForm').addEventListener('input', () => { readSetupForm(); renderSetupStatus(); });
  $('generateBtn').onclick = generateQuestion;
  $('readyBtn').onclick = () => {
    readSetupForm();
    const problem = setupProblem();
    if (problem) { $('setupStatus').textContent = problem; return; }
    $('setupStatus').textContent = '';
    sendAction({ t: 'setup', setup: cleanSetup(draft, currentMode()) });
  };
  fillSetupForm();

  // ---------- categoria favorita: la sceglie chi ha fatto meno punti ----------
  function renderBoost(el) {
    el.classList.toggle('hidden', !view.pickerId);
    if (!view.pickerId) return;
    const mine = view.pickerId === view.you;
    const chosen = view.boostCat && catInfo(view.boostCat);
    const who = esc(view.pickerName || 'Un giocatore');
    let text;
    if (mine) {
      text = chosen
        ? `Hai scelto <b>${chosen.emoji} ${esc(chosen.label)}</b>: uscirà più spesso nel prossimo round. Puoi ancora cambiarla.`
        : 'Hai fatto meno punti: scegli una categoria che uscirà più spesso nel prossimo round!';
    } else {
      text = chosen
        ? `${who} ha scelto <b>${chosen.emoji} ${esc(chosen.label)}</b>: uscirà più spesso nel prossimo round.`
        : `${who} ha fatto meno punti e sta scegliendo la categoria favorita del prossimo round…`;
    }
    el.innerHTML = `<h3>🎯 Categoria favorita</h3><div>${text}</div>${mine ? `<div class="chips">${window.CATEGORIES.map((c) => `
      <button type="button" class="chip ${c.id === view.boostCat ? 'on' : ''}" data-id="${c.id}">${c.emoji} ${esc(c.label)}</button>`).join('')}</div>` : ''}`;
  }
  for (const id of ['boostLobby', 'boostFinal']) {
    $(id).addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (btn && view && view.pickerId === view.you) sendAction({ t: 'boost', cat: btn.dataset.id });
    });
  }

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
    if (name) createRoom(name, homeAvatar, 'classic');
  };
  $('createPlusBtn').onclick = () => {
    $('homeError').textContent = '';
    const name = readName();
    if (name) createRoom(name, homeAvatar, 'plus');
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
    if (notReady.length && !confirm(`Non sono ancora pronti: ${notReady.join(', ')}.\nIniziare comunque? Le loro domande non usciranno in questo round.`)) return;
    hostGame.start();
  };
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
