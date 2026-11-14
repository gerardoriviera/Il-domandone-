// Il Domandone — gioco multigiocatore.
// Il browser di chi crea la stanza (l'host) fa da "server": tiene lo stato della partita,
// i timer e i punteggi. I messaggi tra host e ospiti passano da un server ponte MQTT pubblico
// (WebSocket sicuro), così funziona da qualunque rete senza un server nostro.
(() => {
  // Immagini dei giocatori (public/avatars/<nome>.webp): ognuno ne ha una diversa,
  // quindi il numero massimo di giocatori è limitato anche dal numero di immagini.
  const AVATARS = ['pomodoro', 'arancia', 'broccolo', 'banana', 'anguria', 'carota', 'uva', 'mela', 'ananas'];
  const MAX_PLAYERS = Math.min(10, AVATARS.length);
  const QUESTIONS_PER_PLAYER = 5; // nel Classico un round ha 5 domande per ogni giocatore
  const PLUS_QUESTIONS_PER_PLAYER = 3; // nel Plus i blocchi sono più corti: 3 domande per giocatore
  const perPlayer = (mode) => (mode === 'plus' ? PLUS_QUESTIONS_PER_PLAYER : QUESTIONS_PER_PLAYER);
  const BOOST_WEIGHT = 3; // la categoria favorita esce circa 3 volte più spesso delle altre
  const FOOL_POINTS = 250; // punti all'autore della domanda bonus per ogni giocatore che sbaglia
  // Solo nella versione Plus:
  const DRAW_POINTS = 250; // punti all'autore di un disegno per ogni giocatore che indovina
  const GUESS_BONUS = 200; // bonus a chi indovina una domanda o un disegno di un giocatore
  const DRAW_PROMPT = 'Che cosa rappresenta il disegno?';
  const DRAW_MAX_POINTS = 4000; // limite di punti per disegno, per tenere piccoli i messaggi
  const QUESTION_TIME_MS = 20000;
  const REVEAL_TIME_MS = 6000;
  // Plus: sessione "La risposta sbagliata" (fa punti chi sceglie la risposta falsa)
  // Ogni giocatore la gioca al proprio ritmo: appena risponde passa subito alla domanda successiva.
  const WRONG_QUESTIONS = 3;
  const WRONG_TIME_MS = 5000;
  const WRONG_MAX_POINTS = 150;
  const WRONG_MIN_POINTS = 100;
  const FIRST_FINISH_BONUS = 100; // a chi risponde per primo a tutte e 3 le domande
  // Plus: "Indovina chi?" — un'immagine che si scopre a tessere e una parola da indovinare
  const GUESS_TIME_MS = 45000;
  const GUESS_TILES = 16;           // immagine divisa in 4x4 tessere
  const GUESS_END_MS = 5000;
  const GUESS_POINTS = 2 * 750;     // come due risposte corrette date subito
  // Plus: "Cliccami" — vince chi preme più volte il bottone rosso in 5 secondi
  const CLICK_READY_MS = 3000;
  const CLICK_TIME_MS = 5000;
  const CLICK_END_MS = 5000;
  const CLICK_POINTS = 750;         // come una risposta corretta data subito
  const SPECIAL_TYPES = ['wsession', 'guess', 'click', 'song']; // non contano come domande numerate
  // Plus: "SARABAMBA" — parte una canzone, chi si prenota per primo ha 7 secondi per scrivere il titolo
  const SONG_PLAY_MS = 30000;       // musica massima (le pause per le prenotazioni non contano)
  const SONG_ANSWER_MS = 7000;
  const SONG_POINTS = 750;
  const SONG_PENALTY = 250;
  const SONG_END_MS = 5000;
  // "Facciamola finita": se più della metà dei giocatori lo preme entro questo tempo, il round finisce
  const QUIT_WINDOW_MS = 10000;
  const PLAYING_STATES = ['countdown', 'question', 'reveal', 'wsession', 'guess', 'guessEnd', 'click', 'clickEnd', 'song', 'songEnd', 'powerup'];
  const POWERUP_SCREEN_MS = 7000;
  // Power-up del Plus (si usano durante le domande normali, prima di rispondere, uno per domanda)
  const POWERUPS = {
    fifty: { label: '50/50', desc: 'Elimina due delle tre risposte sbagliate: restano quella giusta e una sbagliata.' },
    x2: { label: 'x2', desc: 'Se rispondi giusto, prendi il doppio dei punti.' },
    xx: { label: 'x_x', desc: 'Un avversario a caso non prende punti in questa domanda, anche se risponde giusto.' },
    minus300: { label: '-300', desc: 'Toglie subito 300 punti a tutti gli avversari.' },
    slow: { label: '- -', desc: 'Gli avversari hanno metà del tempo rimasto per rispondere.' },
  };
  const LAST_PLACE_POWERUPS = ['fifty', 'x2']; // per chi è ultimo in classifica
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

  function normTitle(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  }
  function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  }
  function titleMatches(text, answers) {
    const t = normTitle(text);
    if (!t) return false;
    return answers.some((ans) => {
      const a = normTitle(ans);
      return t === a || (a.length >= 6 && editDistance(t, a) <= 1);
    });
  }

  function pointsFor(ms, time = QUESTION_TIME_MS, max = MAX_POINTS, min = MIN_POINTS) {
    const ratio = Math.min(Math.max(ms / time, 0), 1);
    return Math.round(max - (max - min) * ratio);
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
      this.usedWrong = new Set();     // domande già uscite nella sessione "La risposta sbagliata"
      this.usedGuess = new Set();     // immagini già uscite in "Indovina chi?"
      this.usedSongs = new Set();     // canzoni già uscite in "SARABAMBA"
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
        id: makeId(), token: makeId(), name, avatar: this.freeAvatar(avatar), setup: null, score: 0, correctCount: 0, answer: null, powerups: [],
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
      else if (msg.t === 'power') this.usePowerup(player, msg.type);
      else if (msg.t === 'wanswer') this.wsAnswer(player, msg.idx, msg.choice, msg.ms);
      else if (msg.t === 'guess') this.guessTry(player, msg.text);
      else if (msg.t === 'quit') this.voteQuit(player);
      else if (msg.t === 'clicks') this.clickCount(player, msg.n);
      else if (msg.t === 'book') this.songBook(player);
      else if (msg.t === 'songAnswer') this.songAnswer(player, msg.text);
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
      clearInterval(this.wsInterval);
      clearInterval(this.guessInterval);
      clearInterval(this.songInterval);
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
      const per = perPlayer(this.mode);
      const total = per * participants.length;
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
      // Plus: dopo ogni blocco di 5 domande, prima della domanda del giocatore, "La risposta sbagliata":
      // 3 domande dedicate con 2 risposte (una vera e una falsa); fa punti chi sceglie quella falsa.
      const wrongBank = window.WRONG_SESSION_QUESTIONS || [];
      const wrongSession = (session) => {
        let pool = wrongBank.map((_, i) => i).filter((i) => !this.usedWrong.has(i));
        if (pool.length < WRONG_QUESTIONS) { this.usedWrong.clear(); pool = wrongBank.map((_, i) => i); }
        const items = shuffle(pool).slice(0, WRONG_QUESTIONS).map((i) => {
          this.usedWrong.add(i);
          const item = wrongBank[i];
          const options = shuffle([item.a, item.f]);
          // `correct` è la risposta che fa punti, cioè quella falsa; `truth` è quella vera
          return { q: item.q, options, correct: options.indexOf(item.f), truth: options.indexOf(item.a), cat: item.cat };
        });
        return items.length ? [{ type: 'wsession', session, items }] : [];
      };
      // Plus: in ogni blocco compare una volta "Indovina chi?", dopo una domanda a caso del blocco
      const guessBank = window.GUESS_IMAGES || [];
      const guessGame = () => {
        let pool = guessBank.map((_, i) => i).filter((i) => !this.usedGuess.has(i));
        if (!pool.length) { this.usedGuess.clear(); pool = guessBank.map((_, i) => i); }
        if (!pool.length) return [];
        const i = pool[randomInt(pool.length)];
        this.usedGuess.add(i);
        const g = guessBank[i];
        return [{ type: 'guess', cat: g.cat, word: String(g.word).toUpperCase().replace(/[^A-Z]/g, ''), img: g.img }];
      };
      let guessAfter = randomInt(per);
      const clickAfter = randomInt(questions.length); // "Cliccami": una volta per round
      const songAfter = randomInt(questions.length);  // "SARABAMBA": una volta per round
      const songBank = window.SONGS || [];
      const songGame = () => {
        let pool = songBank.map((_, i) => i).filter((i) => !this.usedSongs.has(i));
        if (!pool.length) { this.usedSongs.clear(); pool = songBank.map((_, i) => i); }
        if (!pool.length) return [];
        const i = pool[randomInt(pool.length)];
        this.usedSongs.add(i);
        return [{ type: 'song', song: songBank[i] }];
      };
      const round = [];
      let session = 0;
      questions.forEach((q, i) => {
        round.push(q);
        if (this.mode === 'plus' && i % per === guessAfter) round.push(...guessGame());
        if (this.mode === 'plus' && i === clickAfter) round.push({ type: 'click' });
        if (this.mode === 'plus' && i === songAfter) round.push(...songGame());
        if ((i + 1) % per === 0) {
          guessAfter = randomInt(per);
          if (this.mode === 'plus') round.push(...wrongSession(session++));
          if (customs.length) round.push(customs.shift());
        }
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
        p.powerups = p.powerups || []; // i power-up non usati restano per il round successivo
      }
      this.award = null;
      this.quitVotes = new Map();
      this.quitEnded = false;
      this.state = 'countdown';
      this.phaseEnds = Date.now() + COUNTDOWN_MS;
      this.timer = setTimeout(() => this.nextQuestion(), COUNTDOWN_MS);
      this.broadcast();
    }

    finishRound() {
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
    }

    // ----- "Facciamola finita": voto per chiudere subito il round -----
    activeQuitVotes() {
      const now = Date.now();
      const online = new Set(this.online().map((p) => p.id));
      for (const [id, t] of this.quitVotes) if (now - t > QUIT_WINDOW_MS || !online.has(id)) this.quitVotes.delete(id);
      return this.quitVotes;
    }

    quitNeeded() {
      return Math.floor(this.online().length / 2) + 1; // più della metà dei giocatori collegati
    }

    voteQuit(player) {
      if (!PLAYING_STATES.includes(this.state)) return;
      this.quitVotes = this.quitVotes || new Map();
      this.activeQuitVotes();
      if (this.quitVotes.has(player.id)) return;
      this.quitVotes.set(player.id, Date.now());
      if (this.quitVotes.size >= this.quitNeeded()) {
        this.clearTimer();
        this.quitVotes.clear();
        this.quitEnded = true;
        this.finishRound();
        return;
      }
      // quando il voto scade, tutti devono vedere il contatore aggiornato
      setTimeout(() => { if (PLAYING_STATES.includes(this.state)) this.broadcast(); }, QUIT_WINDOW_MS + 100);
      this.broadcast();
    }

    nextQuestion() {
      this.clearTimer();
      this.qIndex++;
      if (this.qIndex >= this.questions.length) {
        this.finishRound();
        return;
      }
      const q = this.questions[this.qIndex];
      if (q.type === 'wsession') { this.startWrongSession(q); return; }
      if (q.type === 'guess') { this.startGuess(q); return; }
      if (q.type === 'click') { this.startClick(); return; }
      if (q.type === 'song') { this.startSong(q.song); return; }
      const time = QUESTION_TIME_MS;
      for (const p of this.players.values()) {
        p.answer = null;
        // effetti dei power-up: valgono solo per la domanda in cui vengono usati
        p.usedPower = null;
        p.hidden = null;
        p.double = false;
        p.zeroed = false;
        p.deadline = null;
      }
      this.effects = [];
      this.state = 'question';
      this.qStart = Date.now();
      this.phaseEnds = this.qStart + time;
      this.timer = setTimeout(() => this.reveal(), time);
      this.broadcast();
    }

    answer(player, choice, qIndex, clientMs) {
      choice = Number(choice);
      if (this.state !== 'question' || Number(qIndex) !== this.qIndex || player.answer) return;
      if (this.questions[this.qIndex].authorId === player.id) return; // l'autore non risponde alla sua domanda
      if (player.deadline && Date.now() > player.deadline) return; // tempo dimezzato da un power-up e scaduto
      if (player.hidden && player.hidden.includes(Number(choice))) return; // risposta eliminata dal 50/50
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
      const done = (p) => p.answer || (p.deadline && Date.now() > p.deadline);
      if (online.length === 0 || online.every(done)) {
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
        if (ok && p.double) p.answer.points *= 2; // power-up x2
        if (p.zeroed) p.answer.points = 0;         // colpito da x_x
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

    // ----- sessione "La risposta sbagliata": ogni giocatore avanza per conto suo -----
    startWrongSession(q) {
      const now = Date.now();
      this.ws = { items: q.items, firstId: null, firstName: null };
      for (const p of this.players.values()) {
        p.sessionPoints = 0;
        p.ws = { idx: 0, qStart: now, results: [], done: !p.connected, timedOut: false, bonus: 0 };
      }
      this.state = 'wsession';
      this.phaseEnds = null;
      this.wsInterval = setInterval(() => this.wsTick(), 200);
      this.broadcast();
    }

    // passa avanti chi ha lasciato scadere i 5 secondi
    wsTick() {
      if (this.state !== 'wsession') return;
      const now = Date.now();
      let changed = false;
      for (const p of this.online()) {
        if (p.ws && !p.ws.done && now - p.ws.qStart > WRONG_TIME_MS + 300) {
          p.ws.results.push({ choice: null, ok: false, points: 0 });
          p.ws.timedOut = true;
          this.wsAdvance(p);
          changed = true;
        }
      }
      if (changed) this.broadcast();
      this.wsMaybeEnd();
    }

    wsAnswer(player, idx, choice, clientMs) {
      if (this.state !== 'wsession' || !player.ws || player.ws.done || Number(idx) !== player.ws.idx) return;
      choice = Number(choice);
      if (choice !== 0 && choice !== 1) return;
      const hostMs = Date.now() - player.ws.qStart;
      if (hostMs > WRONG_TIME_MS + 300) return;
      let ms = hostMs;
      if (Number.isFinite(clientMs)) ms = Math.min(hostMs, Math.max(hostMs - 2000, clientMs));
      const item = this.ws.items[player.ws.idx];
      const ok = choice === item.correct;
      const points = ok ? pointsFor(Math.max(0, ms), WRONG_TIME_MS, WRONG_MAX_POINTS, WRONG_MIN_POINTS) : 0;
      player.score += points;
      player.sessionPoints += points;
      player.ws.results.push({ choice, ok, points });
      this.wsAdvance(player);
      this.broadcast();
      this.wsMaybeEnd();
    }

    wsAdvance(p) {
      p.ws.idx++;
      p.ws.qStart = Date.now();
      if (p.ws.idx < this.ws.items.length) return;
      p.ws.done = true;
      // bonus a chi risponde per primo a tutte le domande (senza far scadere il tempo)
      if (!p.ws.timedOut && !this.ws.firstId) {
        this.ws.firstId = p.id;
        this.ws.firstName = p.name;
        p.ws.bonus = FIRST_FINISH_BONUS;
        p.score += FIRST_FINISH_BONUS;
        p.sessionPoints += FIRST_FINISH_BONUS;
      }
    }

    wsMaybeEnd() {
      if (this.state !== 'wsession' || this.wsEnding) return;
      const online = this.online();
      if (online.length && !online.every((p) => p.ws && p.ws.done)) return;
      this.wsEnding = true;
      clearInterval(this.wsInterval);
      setTimeout(() => { this.wsEnding = false; if (this.state === 'wsession') this.giveAwards(); }, 1200);
    }

    // Fine della sessione "La risposta sbagliata": power-up a chi ha fatto più punti nella sessione
    // e a chi è ultimo nella classifica generale.
    // ----- "SARABAMBA" -----
    startSong(song) {
      const now = Date.now();
      this.song = { song, playedMs: 0, playStart: now, bookedBy: null, bookedUntil: 0, locked: new Set(), wrong: [], winnerId: null, winnerName: null, award: null };
      this.state = 'song';
      this.phaseEnds = null;
      this.songInterval = setInterval(() => this.songTick(), 200);
      this.broadcast();
    }

    songPlayed() {
      const g = this.song;
      return g.playedMs + (g.bookedBy ? 0 : Date.now() - g.playStart);
    }

    songTick() {
      if (this.state !== 'song') return;
      const g = this.song;
      if (g.bookedBy && Date.now() > g.bookedUntil + 400) {
        const p = this.players.get(g.bookedBy);
        if (p) this.songWrong(p, null); // tempo scaduto
        return;
      }
      if (!g.bookedBy && this.songPlayed() >= SONG_PLAY_MS) this.endSong(null);
    }

    songBook(player) {
      if (this.state !== 'song') return;
      const g = this.song;
      if (g.bookedBy || g.locked.has(player.id)) return;
      g.playedMs = this.songPlayed(); // la musica si ferma per tutti
      g.bookedBy = player.id;
      g.bookedUntil = Date.now() + SONG_ANSWER_MS;
      this.broadcast();
    }

    songAnswer(player, text) {
      if (this.state !== 'song') return;
      const g = this.song;
      if (g.bookedBy !== player.id || Date.now() > g.bookedUntil + 600) return;
      if (titleMatches(text, g.song.answers)) this.endSong(player);
      else this.songWrong(player, String(text || '').slice(0, 60));
    }

    // risposta sbagliata o tempo scaduto: -250 punti, niente più tentativi, la musica riparte
    songWrong(player, text) {
      const g = this.song;
      player.score = Math.max(0, player.score - SONG_PENALTY);
      g.locked.add(player.id);
      g.wrong.push({ name: player.name, text });
      g.bookedBy = null;
      g.playStart = Date.now();
      if (this.online().every((p) => g.locked.has(p.id))) { this.endSong(null); return; }
      this.broadcast();
    }

    endSong(winner) {
      if (this.state !== 'song') return;
      this.clearTimer();
      const g = this.song;
      if (winner) {
        const type = Object.keys(POWERUPS)[randomInt(Object.keys(POWERUPS).length)];
        winner.score += SONG_POINTS;
        winner.powerups = winner.powerups || [];
        winner.powerups.push(type);
        g.winnerId = winner.id;
        g.winnerName = winner.name;
        g.award = type;
      }
      g.bookedBy = null;
      this.state = 'songEnd';
      this.phaseEnds = Date.now() + SONG_END_MS;
      this.timer = setTimeout(() => this.nextQuestion(), SONG_END_MS);
      this.broadcast();
    }

    // ----- "Cliccami" -----
    startClick() {
      const now = Date.now();
      this.click = { goAt: now + CLICK_READY_MS, endAt: now + CLICK_READY_MS + CLICK_TIME_MS, counts: new Map(), winnerId: null, winnerName: null, award: null, best: 0 };
      this.state = 'click';
      this.phaseEnds = this.click.endAt;
      this.timer = setTimeout(() => this.endClick(), CLICK_READY_MS + CLICK_TIME_MS + 700); // margine per gli ultimi conteggi
      this.broadcast();
    }

    // ogni giocatore manda il proprio conteggio più volte al secondo
    clickCount(player, n) {
      if (this.state !== 'click' || !this.click) return;
      const now = Date.now();
      if (now < this.click.goAt || now > this.click.endAt + 700) return;
      n = Math.max(0, Math.min(200, Math.floor(Number(n) || 0))); // più di 40 clic al secondo non è umano
      if (n <= (this.click.counts.get(player.id) || 0)) return;
      this.click.counts.set(player.id, n);
      this.broadcast();
    }

    endClick() {
      if (this.state !== 'click') return;
      this.clearTimer();
      const c = this.click;
      const best = Math.max(0, ...c.counts.values());
      const top = this.online().filter((p) => best > 0 && (c.counts.get(p.id) || 0) === best);
      if (top.length) {
        const winner = top[randomInt(top.length)];
        const type = Object.keys(POWERUPS)[randomInt(Object.keys(POWERUPS).length)];
        winner.score += CLICK_POINTS;
        winner.powerups = winner.powerups || [];
        winner.powerups.push(type); // si aggiunge a quelli che ha già
        c.winnerId = winner.id;
        c.winnerName = winner.name;
        c.award = type;
        c.best = best;
      }
      this.state = 'clickEnd';
      this.phaseEnds = Date.now() + CLICK_END_MS;
      this.timer = setTimeout(() => this.nextQuestion(), CLICK_END_MS);
      this.broadcast();
    }

    // ----- "Indovina chi?" -----
    startGuess(item) {
      const now = Date.now();
      this.guess = {
        item, start: now, winnerId: null, winnerName: null, award: null, publicCount: 0,
        tileOrder: shuffle([...Array(GUESS_TILES).keys()]),
        letterOrder: shuffle([...Array(item.word.length).keys()]),
      };
      for (const p of this.players.values()) { p.gKnown = new Set(); p.gTries = 0; p.gLast = null; }
      this.state = 'guess';
      this.phaseEnds = now + GUESS_TIME_MS;
      this.timer = setTimeout(() => this.endGuess(null), GUESS_TIME_MS);
      this.guessInterval = setInterval(() => this.guessTick(), 300);
      this.broadcast();
    }

    // da metà del tempo compaiono lettere per tutti (mai l'ultima)
    guessTick() {
      if (this.state !== 'guess') return;
      const g = this.guess;
      const len = g.item.word.length;
      const elapsed = Date.now() - g.start;
      const half = GUESS_TIME_MS / 2;
      const n = elapsed < half ? 0 : Math.min(len - 1, Math.floor((elapsed - half) / (half / len)) + 1);
      if (n !== g.publicCount) { g.publicCount = n; this.broadcast(); }
    }

    guessTry(player, text) {
      if (this.state !== 'guess' || !this.guess || this.guess.winnerId) return;
      const word = this.guess.item.word;
      const t = String(text || '').toUpperCase().replace(/[^A-Z]/g, '');
      if (t.length !== word.length) return;
      player.gTries++;
      if (t === word) { this.endGuess(player); return; }
      let found = 0;
      for (let i = 0; i < word.length; i++) {
        if (t[i] === word[i] && !player.gKnown.has(i)) { player.gKnown.add(i); found++; }
      }
      player.gLast = { found, at: Date.now() };
      this.broadcast();
    }

    endGuess(winner) {
      if (this.state !== 'guess') return;
      this.clearTimer();
      const g = this.guess;
      if (winner) {
        const type = Object.keys(POWERUPS)[randomInt(Object.keys(POWERUPS).length)];
        winner.score += GUESS_POINTS;
        winner.powerups = winner.powerups || [];
        winner.powerups.push(type); // si aggiunge a quelli che ha già
        g.winnerId = winner.id;
        g.winnerName = winner.name;
        g.award = type;
      }
      this.state = 'guessEnd';
      this.phaseEnds = Date.now() + GUESS_END_MS;
      this.timer = setTimeout(() => this.nextQuestion(), GUESS_END_MS);
      this.broadcast();
    }

    giveAwards() {
      this.clearTimer();
      const online = this.online();
      const pick = (list) => list[randomInt(list.length)];
      const best = Math.max(0, ...online.map((p) => p.sessionPoints || 0));
      const winner = best > 0 ? pick(online.filter((p) => (p.sessionPoints || 0) === best)) : null;
      const minScore = Math.min(...online.map((p) => p.score));
      const last = online.length > 1 ? pick(online.filter((p) => p.score === minScore)) : null;
      this.award = { winner: null, last: null, first: this.ws && this.ws.firstName ? { name: this.ws.firstName, bonus: FIRST_FINISH_BONUS } : null };
      if (winner) {
        const type = pick(Object.keys(POWERUPS));
        winner.powerups.push(type);
        this.award.winner = { id: winner.id, name: winner.name, points: best, type };
      }
      if (last) {
        const type = pick(LAST_PLACE_POWERUPS);
        last.powerups.push(type);
        this.award.last = { id: last.id, name: last.name, type };
      }
      this.state = 'powerup';
      this.phaseEnds = Date.now() + POWERUP_SCREEN_MS;
      this.timer = setTimeout(() => this.nextQuestion(), POWERUP_SCREEN_MS);
      this.broadcast();
    }

    usePowerup(player, type) {
      const q = this.questions[this.qIndex];
      if (this.state !== 'question' || !q || q.type === 'wsession' || q.authorId) return;
      if (player.answer || player.usedPower || !POWERUPS[type]) return;
      const i = (player.powerups || []).indexOf(type);
      if (i < 0) return;
      player.powerups.splice(i, 1);
      player.usedPower = type;
      const opponents = this.online().filter((p) => p !== player);
      const effect = { by: player.name, type, target: null };
      if (type === 'fifty') {
        const wrong = q.options.map((_, k) => k).filter((k) => k !== q.correct);
        player.hidden = shuffle(wrong).slice(0, 2);
      } else if (type === 'x2') {
        player.double = true;
      } else if (type === 'xx' && opponents.length) {
        const target = opponents[randomInt(opponents.length)];
        target.zeroed = true;
        effect.target = target.name;
      } else if (type === 'minus300') {
        for (const p of opponents) p.score = Math.max(0, p.score - 300);
      } else if (type === 'slow') {
        const now = Date.now();
        const half = Math.max(0, this.phaseEnds - now) / 2;
        for (const p of opponents) if (!p.answer) p.deadline = Math.min(p.deadline || Infinity, now + half);
        setTimeout(() => this.maybeEndQuestionEarly(), half + 100);
      }
      this.effects.push(effect);
      this.broadcast();
    }

    backToLobby() {
      this.clearTimer();
      this.state = 'lobby';
      this.phaseEnds = null;
      this.award = null;
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
          powerups: p.powerups || [],
          sessionPoints: p.sessionPoints || 0,
          wsStep: p.ws ? p.ws.idx : 0,
          wsDone: !!(p.ws && p.ws.done),
        }))
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    }

    viewFor(player, players) {
      const view = {
        room: this.code,
        mode: this.mode,
        state: this.state,
        qIndex: this.qIndex, // anche fuori dalle domande: serve a riconoscere ogni nuova sessione o gioco
        you: player.id,
        hostId: this.hostId,
        maxPlayers: MAX_PLAYERS,
        total: this.questions.filter((q) => !SPECIAL_TYPES.includes(q.type)).length,
        qNumber: this.questions.slice(0, this.qIndex + 1).filter((q) => !SPECIAL_TYPES.includes(q.type)).length,
        clickCount: this.questions.filter((q) => q.type === 'click').length,
        songCount: this.questions.filter((q) => q.type === 'song').length,
        blockSize: perPlayer(this.mode),
        guessCount: this.questions.filter((q) => q.type === 'guess').length,
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
        remainingMs: this.phaseEnds ? Math.max(0, Math.min(this.phaseEnds, player.deadline || Infinity) - Date.now()) : null,
        wrongCount: this.questions.filter((q) => q.type === 'wsession').length,
        quit: this.quitView(player),
        quitEnded: this.state === 'final' && !!this.quitEnded,
        myPowerups: player.powerups || [],
        award: this.state === 'powerup' ? this.award : null,
        players,
      };
      if ((this.state === 'song' || this.state === 'songEnd') && this.song) {
        const g = this.song;
        const ended = this.state === 'songEnd';
        const booked = g.bookedBy ? this.players.get(g.bookedBy) : null;
        view.song = {
          bpm: g.song.bpm, notes: g.song.notes, ended, playing: !ended && !booked,
          offsetMs: ended ? 0 : this.songPlayed(), maxMs: SONG_PLAY_MS,
          bookedName: booked ? booked.name : null, bookedIsYou: !!booked && booked.id === player.id,
          bookLeftMs: booked ? Math.max(0, g.bookedUntil - Date.now()) : 0, answerMs: SONG_ANSWER_MS,
          locked: g.locked.has(player.id), wrong: g.wrong, penalty: SONG_PENALTY, points: SONG_POINTS,
          title: ended ? g.song.title : null, winnerName: g.winnerName, winnerIsYou: g.winnerId === player.id, award: g.award,
        };
      }
      if ((this.state === 'click' || this.state === 'clickEnd') && this.click) {
        const c = this.click;
        const now = Date.now();
        view.click = {
          ended: this.state === 'clickEnd', goInMs: Math.max(0, c.goAt - now), leftMs: Math.max(0, c.endAt - now),
          time: CLICK_TIME_MS, mine: c.counts.get(player.id) || 0,
          board: this.online().map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, n: c.counts.get(p.id) || 0 })).sort((a, b) => b.n - a.n),
          winnerName: c.winnerName, winnerIsYou: c.winnerId === player.id, award: c.award, points: CLICK_POINTS, best: c.best,
        };
      }
      if ((this.state === 'guess' || this.state === 'guessEnd') && this.guess) {
        const g = this.guess;
        const word = g.item.word;
        const ended = this.state === 'guessEnd';
        const pub = new Set(g.letterOrder.slice(0, g.publicCount));
        const known = player.gKnown || new Set();
        view.guess = {
          cat: g.item.cat, img: g.item.img, len: word.length, duration: GUESS_TIME_MS,
          elapsed: Math.min(GUESS_TIME_MS, Date.now() - g.start), tileOrder: g.tileOrder, ended,
          letters: [...word].map((ch, i) => (ended || pub.has(i) || known.has(i) ? ch : '')),
          mine: [...word].map((_, i) => known.has(i)),
          tries: player.gTries || 0, last: player.gLast,
          winnerName: g.winnerName, winnerIsYou: g.winnerId === player.id, award: g.award, points: GUESS_POINTS,
          word: ended ? word : null,
        };
      }
      if (this.state === 'wsession' && player.ws) {
        const w = player.ws;
        const item = this.ws.items[w.idx];
        const lastRes = w.results[w.results.length - 1];
        const lastItem = this.ws.items[w.results.length - 1];
        view.ws = {
          step: w.idx, total: this.ws.items.length, done: w.done, bonus: w.bonus, sessionPoints: player.sessionPoints,
          firstName: this.ws.firstName, time: WRONG_TIME_MS,
          question: item ? { text: item.q, options: item.options, cat: item.cat } : null,
          last: lastRes ? { ok: lastRes.ok, points: lastRes.points, timeout: lastRes.choice == null, truth: lastItem.options[lastItem.truth] } : null,
        };
        view.remainingMs = item ? Math.max(0, WRONG_TIME_MS - (Date.now() - w.qStart)) : null;
      }
      if (this.state === 'question' || this.state === 'reveal') {
        const q = this.questions[this.qIndex];
        view.qIndex = this.qIndex;
        view.question = { text: q.q, options: q.options, cat: q.cat, author: q.authorName || null, kind: q.kind || 'question', type: q.type || (q.authorId ? 'custom' : 'normal') };
        view.hidden = player.hidden || [];
        view.usedPower = player.usedPower || null;
        view.slowed = !!player.deadline;
        view.effects = this.effects || [];
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

    quitView(player) {
      if (!PLAYING_STATES.includes(this.state)) return null;
      const votes = this.quitVotes ? this.activeQuitVotes() : new Map();
      const names = [...votes.keys()].map((id) => (this.players.get(id) || {}).name).filter(Boolean);
      const first = Math.min(...votes.values());
      return {
        votes: votes.size, needed: this.quitNeeded(), names, youVoted: votes.has(player.id),
        leftMs: votes.size ? Math.max(0, QUIT_WINDOW_MS - (Date.now() - first)) : 0,
      };
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
      if (window.DOMANDONE_DEBUG) window.__domandoneHost = game; // solo per i test automatici
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
      else if (msg.t === 'power') hostGame.usePowerup(me, msg.type);
      else if (msg.t === 'wanswer') hostGame.wsAnswer(me, msg.idx, msg.choice, msg.ms);
      else if (msg.t === 'guess') hostGame.guessTry(me, msg.text);
      else if (msg.t === 'quit') hostGame.voteQuit(me);
      else if (msg.t === 'clicks') hostGame.clickCount(me, msg.n);
      else if (msg.t === 'book') hostGame.songBook(me);
      else if (msg.t === 'songAnswer') hostGame.songAnswer(me, msg.text);
    } else {
      sendToHost(msg);
    }
  }

  function answer(i) {
    if (!view || view.state !== 'question' || view.yourAnswer != null) return;
    if (deadline != null && performance.now() > deadline) return; // tempo scaduto (anche se dimezzato da un power-up)
    if ((view.hidden || []).includes(i)) return;
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
    for (const s of ['home', 'lobby', 'countdown', 'game', 'wsession', 'guess', 'click', 'song', 'powerup', 'final']) $(s).classList.toggle('hidden', s !== id);
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
    renderQuit();
    if (s.state !== 'song') stopMusic();
    if (s.state === 'lobby') renderLobby();
    else if (s.state === 'countdown') renderCountdown();
    else if (s.state === 'question' || s.state === 'reveal') renderGame();
    else if (s.state === 'wsession') renderWrongSession();
    else if (s.state === 'guess' || s.state === 'guessEnd') renderGuess();
    else if (s.state === 'click' || s.state === 'clickEnd') renderClick();
    else if (s.state === 'song' || s.state === 'songEnd') renderSong();
    else if (s.state === 'powerup') renderPowerup();
    else if (s.state === 'final') renderFinal();
  }

  // QR code con il link della stanza: chi lo inquadra entra con il codice già inserito
  let qrLink = '';
  function renderQr(link) {
    if (link === qrLink) return;
    qrLink = link;
    const box = $('qrCode');
    try {
      const qr = qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      $('qrBox').classList.remove('hidden');
    } catch {
      $('qrBox').classList.add('hidden'); // senza QR resta comunque il link da copiare
    }
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
    $('legendBtn').classList.toggle('hidden', !plus);
    if (!plus && draft.custom.kind === 'drawing') setKind('question');
    const link = `${location.origin}${location.pathname}?room=${view.room}`;
    $('shareLink').value = link;
    renderQr(link);
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
        : (view.bonusCount === 1 ? 'domanda scritta da un giocatore' : 'domande scritte dai giocatori')}, una ogni ${view.blockSize}!` : ''}</div>
      ${view.clickCount ? `<div>🔴 E da qualche parte c'è <b>Cliccami</b>: vince chi preme di più il bottone rosso in 5 secondi!</div>` : ''}
      ${view.guessCount ? `<div>🕵️ In ogni blocco c'è anche un <b>Indovina chi?</b> a sorpresa: chi indovina vince ${GUESS_POINTS} punti e un power-up!</div>` : ''}
      ${view.songCount ? `<div>🎵 E arriverà anche <b>SARABAMBA</b>: prenotati e indovina il titolo della canzone!</div>` : ''}
      ${view.wrongCount ? `<div>🙃 Dopo ogni ${view.blockSize} domande c'è <b>La risposta sbagliata</b>: chi la vince riceve un power-up!</div>` : ''}
      ${boost ? `<div class="cat-mix"><span class="chip on">🎯 Categoria favorita: ${info.emoji} ${esc(info.label)}${boost.by ? ' · scelta da ' + esc(boost.by) : ''}</span></div>` : ''}`;
  }

  function renderGame() {
    show('game');
    const q = view.question;
    const key = `${view.room}:${view.qIndex}:${view.state}`;
    const isReveal = view.state === 'reveal';
    const isBonus = q.cat === 'bonus';
    $('qCounter').textContent = `${isBonus ? '⭐ ' : ''}Domanda ${view.qNumber}/${view.total}`;
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
      $('answers').classList.remove('expired');
      $('answers').innerHTML = q.options.map((opt, i) => `
        <button class="answer" data-i="${i}"><span class="letter">${LETTERS[i]}</span><span>${esc(opt)}</span></button>`).join('');
      $('answers').querySelectorAll('.answer').forEach((btn) => btn.addEventListener('click', () => answer(Number(btn.dataset.i))));
    }

    const buttons = [...$('answers').querySelectorAll('.answer')];
    buttons.forEach((btn, i) => {
      const gone = (view.hidden || []).includes(i);
      btn.classList.toggle('gone', gone && !isReveal);
      btn.disabled = view.yourAnswer != null || isReveal || view.isAuthor || gone || $('answers').classList.contains('expired');
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
        const extra = [view.yourBonus ? `bonus +${view.yourBonus} incluso` : '', view.usedPower === 'x2' && ok ? 'x2!' : ''].filter(Boolean).join(' · ');
        const zeroed = view.effects.some((e) => e.type === 'xx' && e.target === me().name);
        banner.textContent = ok
          ? (zeroed ? 'Corretto, ma colpito da x_x: 0 punti!' : `Corretto! +${view.yourPoints} punti (${(me().lastMs / 1000).toFixed(2)}s)${extra ? ' · ' + extra : ''}`)
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
      $('qStatus').textContent = view.slowed && view.remainingMs === 0 && view.yourAnswer == null ? 'Tempo dimezzato da un avversario: scaduto!'
        : view.isAuthor
        ? (isDrawing
          ? `È il tuo disegno! Guadagni ${view.drawPoints} punti per ogni giocatore che indovina. (${answered}/${online.length} hanno risposto)`
          : `È la tua domanda! Guadagni ${view.foolPoints} punti per ogni giocatore che sbaglia. (${answered}/${online.length} hanno risposto)`)
        : view.yourAnswer != null
          ? `Risposta inviata! In attesa degli altri… (${answered}/${online.length})`
          : `${answered}/${online.length} hanno risposto`;
    }
    renderPowerBar(q, isReveal);
    renderEffects();
  }

  // Power-up: pulsanti per usarli (solo domande normali, prima di rispondere, uno per domanda)
  function renderPowerBar(q, isReveal) {
    const bar = $('powerBar');
    const mine = view.myPowerups || [];
    const usable = view.mode === 'plus' && !isReveal && q.type === 'normal' && view.yourAnswer == null && !view.usedPower;
    const show = view.mode === 'plus' && (mine.length || view.usedPower);
    bar.classList.toggle('hidden', !show);
    if (!show) return;
    const used = view.usedPower ? `<span class="muted">Usato: <b>${POWERUPS[view.usedPower].label}</b></span>` : '';
    const counts = {};
    for (const t of mine) counts[t] = (counts[t] || 0) + 1;
    bar.innerHTML = `<span class="muted">⚡ I tuoi power-up:</span>${Object.entries(counts).map(([t, n]) => `
      <button type="button" class="chip power" data-type="${t}" ${usable ? '' : 'disabled'} title="${esc(POWERUPS[t].desc)}">${POWERUPS[t].label}${n > 1 ? ` ×${n}` : ''}</button>`).join('')}${used}`;
  }

  function renderEffects() {
    const fx = (view.effects || []).map((e) => {
      const p = POWERUPS[e.type].label;
      if (e.type === 'xx') return `💥 ${esc(e.by)} ha usato <b>${p}</b> su ${esc(e.target || '—')}`;
      if (e.type === 'minus300') return `💥 ${esc(e.by)} ha usato <b>${p}</b>: −300 a tutti gli avversari!`;
      if (e.type === 'slow') return `💥 ${esc(e.by)} ha usato <b>${p}</b>: avversari con metà del tempo!`;
      return `⚡ ${esc(e.by)} ha usato <b>${p}</b>`;
    });
    $('powerFeed').classList.toggle('hidden', !fx.length);
    $('powerFeed').innerHTML = fx.join('<br>');
  }

  // ---------- sessione "La risposta sbagliata" ----------
  let wsKey = '';
  let wsShownAt = 0;
  function renderWrongSession() {
    show('wsession');
    renderedKey = '';
    const w = view.ws;
    if (!w) return;
    const key = `${view.qIndex}:${w.step}`;
    const last = w.last;
    $('wsLast').className = `ws-last ${last ? (last.ok ? 'good' : 'bad') : ''}`;
    $('wsLast').textContent = !last ? '' : last.timeout ? `⏱ Tempo scaduto! La vera era: ${last.truth}`
      : last.ok ? `✅ Giusto, era falsa: +${last.points}` : `❌ Era quella vera! (${last.truth})`;
    $('wsCounter').textContent = w.done ? 'Finito!' : `Domanda ${w.step + 1}/${w.total}`;
    $('wsScore').textContent = `${w.sessionPoints} pt sessione`;
    $('wsPlay').classList.toggle('hidden', w.done);
    $('wsDone').classList.toggle('hidden', !w.done);
    if (!w.done && key !== wsKey) {
      wsKey = key;
      wsShownAt = performance.now();
      const info = catInfo(w.question.cat);
      $('wsCat').textContent = `${info.emoji} ${info.label}`;
      $('wsText').textContent = w.question.text;
      $('wsAnswers').innerHTML = w.question.options.map((opt, i) => `
        <button class="answer" data-i="${i}"><span class="letter">${LETTERS[i]}</span><span>${esc(opt)}</span></button>`).join('');
    }
    if (w.done) {
      $('wsTime').textContent = '';
      $('wsTimerBar').style.transform = 'scaleX(0)';
      const html = `<div class="banner good">Hai finito con ${w.sessionPoints} punti${w.bonus ? ` · 🏃 primo a finire: bonus +${w.bonus} incluso!` : ''}</div>
        <div class="muted center">Aspetta che finiscano gli altri…</div>`;
      if ($('wsDone').dataset.html !== html) { $('wsDone').dataset.html = html; $('wsDone').innerHTML = html; }
    }
    $('wsProgress').innerHTML = view.players.filter((p) => p.connected).map((p) => {
      const dots = Array.from({ length: w.total }, (_, i) => (i < p.wsStep ? '●' : '○')).join('');
      return `<div class="ws-row">${avatar(p, 'small')}<span class="name">${esc(p.name)}</span><span class="dots">${p.wsDone ? '✔' : dots}</span>${
        w.firstName === p.name ? '<span class="chip on">🏃 primo</span>' : ''}</div>`;
    }).join('');
  }
  $('wsAnswers').addEventListener('click', (e) => {
    const btn = e.target.closest('.answer');
    if (!btn || btn.disabled || !view || !view.ws || view.ws.done) return;
    if (deadline != null && performance.now() > deadline) return;
    for (const b of $('wsAnswers').querySelectorAll('.answer')) b.disabled = true;
    sendAction({ t: 'wanswer', idx: view.ws.step, choice: Number(btn.dataset.i), ms: performance.now() - wsShownAt });
  });

  // ---------- audio: le melodie si suonano nel browser, nota per nota ----------
  let audioCtx = null;
  let music = null; // { gain, oscs } della melodia in riproduzione
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch {}
  }
  // i browser permettono l'audio solo dopo un gesto dell'utente: lo sblocchiamo al primo tocco
  document.addEventListener('pointerdown', unlockAudio, { capture: true });
  document.addEventListener('keydown', unlockAudio, { capture: true });

  const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function noteFreq(name) {
    const m = /^([A-G])(#|b)?(\d)$/.exec(name);
    if (!m) return null;
    const semis = NOTE_INDEX[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
    return 440 * Math.pow(2, (semis - 69) / 12);
  }
  function parseSong(song) {
    const beat = 60 / song.bpm;
    let t = 0;
    const notes = song.notes.split(/\s+/).map((tok) => {
      const [n, d] = tok.split(':');
      const dur = Number(d) * beat;
      const out = { f: n === 'R' ? null : noteFreq(n), start: t, dur };
      t += dur;
      return out;
    });
    return { notes, length: t + beat }; // una piccola pausa prima di ricominciare
  }
  function stopMusic() {
    if (!music) return;
    try {
      music.gain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.03);
      for (const o of music.oscs) o.stop(audioCtx.currentTime + 0.2);
    } catch {}
    music = null;
  }
  // suona la melodia (in loop) partendo da offsetSec, per al massimo maxSec
  function playMusic(song, offsetSec, maxSec) {
    stopMusic();
    if (!audioCtx) return;
    const { notes, length } = parseSong(song);
    const gain = audioCtx.createGain();
    gain.gain.value = 0.32;
    gain.connect(audioCtx.destination);
    const oscs = [];
    const now = audioCtx.currentTime + 0.05;
    const until = Math.max(0, maxSec - offsetSec);
    for (let loop = Math.floor(offsetSec / length); loop * length < offsetSec + until; loop++) {
      for (const n of notes) {
        const at = loop * length + n.start - offsetSec;
        if (!n.f || at < 0 || at > until) continue;
        const o = audioCtx.createOscillator();
        const env = audioCtx.createGain();
        o.type = 'triangle';
        o.frequency.value = n.f;
        env.gain.setValueAtTime(0, now + at);
        env.gain.linearRampToValueAtTime(1, now + at + 0.02);
        env.gain.exponentialRampToValueAtTime(0.001, now + at + Math.max(0.12, n.dur * 0.95));
        o.connect(env).connect(gain);
        o.start(now + at);
        o.stop(now + at + n.dur + 0.05);
        oscs.push(o);
      }
    }
    music = { gain, oscs };
  }

  // ---------- "SARABAMBA" ----------
  let songKey = '';
  let songPlayingKey = '';
  let bookDeadline = 0;
  function renderSong() {
    show('song');
    renderedKey = '';
    const g = view.song;
    if (!g) return;
    const key = `${view.qIndex}`;
    if (key !== songKey) {
      songKey = key;
      songPlayingKey = '';
      $('songAnswer').value = '';
      $('songResult').classList.add('hidden');
    }
    // la musica suona per tutti finché nessuno è prenotato; riparte dallo stesso punto
    const playKey = `${key}:${g.playing}:${g.wrong.length}`;
    if (g.playing && playKey !== songPlayingKey) {
      songPlayingKey = playKey;
      unlockAudio();
      playMusic(g, g.offsetMs / 1000, g.maxMs / 1000);
    } else if (!g.playing) {
      songPlayingKey = playKey;
      stopMusic();
    }
    $('songWave').classList.toggle('on', g.playing);
    const canBook = !g.ended && g.playing && !g.locked;
    $('bookBtn').disabled = !canBook;
    $('bookBtn').classList.toggle('hidden', g.bookedIsYou || g.ended);
    $('songAnswerBox').classList.toggle('hidden', !g.bookedIsYou);
    bookDeadline = g.bookedName ? performance.now() + g.bookLeftMs : 0;
    if (g.bookedIsYou && document.activeElement !== $('songAnswer')) $('songAnswer').focus();
    $('songWrong').innerHTML = g.wrong.map((w) => `❌ ${esc(w.name)}: ${w.text ? `"${esc(w.text)}"` : 'tempo scaduto'} (−${g.penalty})`).join('<br>');
    updateSongStatus();
    if (g.ended) {
      stopMusic();
      $('songResult').classList.remove('hidden');
      const pw = g.award ? POWERUPS[g.award].label : '';
      $('songResult').className = `banner ${g.winnerIsYou ? 'good' : 'bad'}`;
      $('songResult').textContent = g.winnerIsYou ? `🎉 Esatto, era "${g.title}"! +${g.points} punti e il power-up ${pw}`
        : g.winnerName ? `${g.winnerName} ha indovinato "${g.title}": +${g.points} punti e il power-up ${pw}`
          : `Nessuno ha indovinato: era "${g.title}"`;
    }
  }
  function updateSongStatus() {
    const g = view && view.song;
    if (!g) return;
    const left = Math.max(0, Math.ceil((bookDeadline - performance.now()) / 1000));
    $('songStatus').textContent = g.ended ? ''
      : g.bookedIsYou ? `Scrivi il titolo! ${left}s`
        : g.bookedName ? `⏸ ${g.bookedName} si è prenotato… ${left}s`
          : g.locked ? 'Hai sbagliato: non puoi più rispondere a questa canzone'
            : '🎶 Ascolta e prenotati appena la riconosci!';
  }
  $('bookBtn').onclick = () => {
    unlockAudio();
    if (!view || !view.song || $('bookBtn').disabled) return;
    $('bookBtn').disabled = true;
    sendAction({ t: 'book' });
  };
  function sendSongAnswer() {
    const text = $('songAnswer').value.trim();
    if (!text || !view || !view.song || !view.song.bookedIsYou) return;
    sendAction({ t: 'songAnswer', text });
    $('songAnswer').value = '';
  }
  $('songSendBtn').onclick = sendSongAnswer;
  $('songAnswer').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendSongAnswer(); } });

  // ---------- "Cliccami" ----------
  let clickKey = '';
  let clickGoAt = 0;   // performance.now() del "VIA!"
  let clickEndAt = 0;
  let myClicks = 0;
  let sentClicks = 0;
  let clickSender = null;
  function renderClick() {
    show('click');
    renderedKey = '';
    const c = view.click;
    if (!c) return;
    const key = `${view.qIndex}`;
    if (key !== clickKey) {
      clickKey = key;
      myClicks = 0;
      sentClicks = 0;
      $('clickResult').classList.add('hidden');
      clearInterval(clickSender);
      // manda il conteggio più volte al secondo, e un'ultima volta alla fine
      clickSender = setInterval(() => {
        if (myClicks > sentClicks) { sentClicks = myClicks; sendAction({ t: 'clicks', n: myClicks }); }
        if (performance.now() > clickEndAt + 1500) clearInterval(clickSender);
      }, 200);
    }
    if (!c.ended) {
      clickGoAt = performance.now() + c.goInMs;
      clickEndAt = performance.now() + c.leftMs;
    }
    $('clickBoard').innerHTML = c.board.map((p) => `<div class="ws-row">${avatar(p, 'small')}<span class="name">${esc(p.name)}</span><span class="dots">${p.n}</span></div>`).join('');
    if (c.ended) {
      $('clickBtn').disabled = true;
      $('clickState').textContent = 'Tempo scaduto!';
      $('clickResult').classList.remove('hidden');
      const pw = c.award ? POWERUPS[c.award].label : '';
      $('clickResult').className = `banner ${c.winnerIsYou ? 'good' : 'bad'}`;
      $('clickResult').textContent = c.winnerIsYou ? `🎉 Hai vinto con ${c.best} clic! +${c.points} punti e il power-up ${pw}`
        : c.winnerName ? `${c.winnerName} vince con ${c.best} clic: +${c.points} punti e il power-up ${pw}` : 'Nessuno ha cliccato!';
    }
  }
  function updateClick() {
    const c = view && view.click;
    if (!c || c.ended) return;
    const now = performance.now();
    const btn = $('clickBtn');
    if (now < clickGoAt) {
      btn.disabled = true;
      $('clickState').textContent = `Preparati… ${Math.ceil((clickGoAt - now) / 1000)}`;
    } else if (now < clickEndAt) {
      btn.disabled = false;
      $('clickState').textContent = `VIA! ${Math.ceil((clickEndAt - now) / 1000)}s`;
    } else {
      btn.disabled = true;
      $('clickState').textContent = 'Tempo scaduto!';
    }
    $('clickCount').textContent = myClicks;
  }
  $('clickBtn').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const now = performance.now();
    if (!view || !view.click || view.click.ended || now < clickGoAt || now > clickEndAt) return;
    myClicks++;
    $('clickCount').textContent = myClicks;
    $('clickBtn').classList.remove('pop'); void $('clickBtn').offsetWidth; $('clickBtn').classList.add('pop');
  });

  // ---------- "Indovina chi?" ----------
  let guessKey = '';
  let guessStartLocal = 0;
  function renderGuess() {
    show('guess');
    renderedKey = '';
    const g = view.guess;
    if (!g) return;
    const key = `${view.qIndex}`;
    const info = catInfo(g.cat);
    if (key !== guessKey) {
      guessKey = key;
      $('gCat').textContent = `${info.emoji} ${info.label}`;
      $('gTiles').innerHTML = Array.from({ length: 16 }, (_, i) => {
        const x = (i % 4) * 100 / 3;
        const y = Math.floor(i / 4) * 100 / 3;
        return `<div class="g-tile cover" data-i="${i}" style="background-image:url('${g.img}');background-position:${x}% ${y}%"></div>`;
      }).join('');
      $('gLetters').innerHTML = Array.from({ length: g.len }, (_, i) =>
        `<input class="g-letter" data-i="${i}" maxlength="1" autocomplete="off" autocapitalize="characters" spellcheck="false">`).join('');
      $('gFeedback').textContent = '';
      $('gFeedback').className = 'g-feedback';
    }
    guessStartLocal = performance.now() - g.elapsed;
    // lettere giuste (solo tue) e lettere rivelate a tutti restano bloccate
    const inputs = [...$('gLetters').querySelectorAll('.g-letter')];
    inputs.forEach((inp, i) => {
      const ch = g.letters[i];
      if (ch) {
        inp.value = ch;
        inp.readOnly = true;
        inp.classList.toggle('mine', g.mine[i] && !g.ended);
        inp.classList.toggle('pub', !g.mine[i] && !g.ended);
      }
      inp.disabled = g.ended;
    });
    $('gTryBtn').disabled = g.ended;
    if (g.last && !g.ended) {
      $('gFeedback').className = `g-feedback ${g.last.found ? 'good' : 'bad'}`;
      $('gFeedback').textContent = g.last.found ? `Sbagliato, ma hai trovato ${g.last.found} letter${g.last.found === 1 ? 'a' : 'e'} al posto giusto!` : 'Non è quella, riprova!';
    }
    if (g.ended) {
      $('gTime').textContent = '';
      $('gTimerBar').style.transform = 'scaleX(0)';
      for (const t of $('gTiles').querySelectorAll('.g-tile')) t.classList.remove('cover');
      $('gResult').classList.remove('hidden');
      const pw = g.award ? POWERUPS[g.award].label : '';
      $('gResult').className = `banner ${g.winnerIsYou ? 'good' : g.winnerName ? 'bad' : 'bad'}`;
      $('gResult').textContent = g.winnerIsYou ? `🎉 Hai indovinato! +${g.points} punti e il power-up ${pw}`
        : g.winnerName ? `${g.winnerName} ha indovinato "${g.word}": +${g.points} punti e il power-up ${pw}`
          : `Nessuno ha indovinato: era "${g.word}"`;
      $('gFeedback').textContent = '';
    } else {
      $('gResult').classList.add('hidden');
    }
  }

  function guessTiles(elapsed) {
    const g = view && view.guess;
    if (!g) return;
    const shown = g.ended ? 16 : Math.min(16, Math.floor(elapsed / (g.duration / 16)) + 1);
    const visible = new Set(g.tileOrder.slice(0, shown));
    for (const t of $('gTiles').querySelectorAll('.g-tile')) t.classList.toggle('cover', !visible.has(Number(t.dataset.i)));
  }

  function sendGuess() {
    if (!view || !view.guess || view.guess.ended) return;
    const inputs = [...$('gLetters').querySelectorAll('.g-letter')];
    const text = inputs.map((x) => x.value.trim().toUpperCase()).join('');
    if (text.length !== inputs.length) {
      $('gFeedback').className = 'g-feedback bad';
      $('gFeedback').textContent = 'Completa tutte le lettere.';
      return;
    }
    sendAction({ t: 'guess', text });
    // le lettere sbagliate si cancellano, quelle giuste tornano bloccate dall'host
    for (const x of inputs) if (!x.readOnly) x.value = '';
    const first = inputs.find((x) => !x.readOnly);
    if (first) first.focus();
  }

  $('gLetters').addEventListener('input', (e) => {
    const inp = e.target.closest('.g-letter');
    if (!inp) return;
    inp.value = inp.value.toUpperCase().replace(/[^A-Z]/g, '').slice(-1);
    if (!inp.value) return;
    const inputs = [...$('gLetters').querySelectorAll('.g-letter')];
    const next = inputs.slice(inputs.indexOf(inp) + 1).find((x) => !x.readOnly);
    if (next) next.focus();
  });
  $('gLetters').addEventListener('keydown', (e) => {
    const inp = e.target.closest('.g-letter');
    if (!inp) return;
    if (e.key === 'Enter') { e.preventDefault(); sendGuess(); return; }
    if (e.key === 'Backspace' && !inp.value) {
      const inputs = [...$('gLetters').querySelectorAll('.g-letter')];
      const prev = inputs.slice(0, inputs.indexOf(inp)).reverse().find((x) => !x.readOnly);
      if (prev) { prev.value = ''; prev.focus(); e.preventDefault(); }
    }
  });
  $('gTryBtn').onclick = sendGuess;

  // ---------- "Facciamola finita" ----------
  let quitDeadline = 0;
  function renderQuit() {
    const q = view && view.quit;
    $('quitBar').classList.toggle('hidden', !q);
    if (!q) return;
    quitDeadline = q.votes ? performance.now() + q.leftMs : 0;
    $('quitBtn').disabled = q.youVoted;
    $('quitBtn').textContent = q.votes ? `🏳️ Facciamola finita (${q.votes}/${q.needed})` : '🏳️ Facciamola finita';
    $('quitBtn').classList.toggle('voting', q.votes > 0);
    updateQuitInfo();
  }
  function updateQuitInfo() {
    const q = view && view.quit;
    if (!q || !q.votes) { $('quitInfo').textContent = ''; return; }
    const left = Math.max(0, Math.ceil((quitDeadline - performance.now()) / 1000));
    const missing = q.needed - q.votes;
    $('quitInfo').textContent = q.youVoted
      ? `Hai votato: ne serv${missing === 1 ? 'e' : 'ono'} ancora ${missing} entro ${left}s`
      : `${q.names.join(', ')} ${q.names.length === 1 ? 'vuole' : 'vogliono'} finirla! Premi entro ${left}s per chiudere la partita`;
  }
  $('quitBtn').onclick = () => {
    if (!view || !view.quit || view.quit.youVoted) return;
    $('quitBtn').disabled = true;
    sendAction({ t: 'quit' });
  };

  function renderPowerup() {
    show('powerup');
    renderedKey = '';
    const a = view.award || {};
    const line = (x, why) => `<div class="award">${avatar(view.players.find((p) => p.id === x.id) || { avatar: 0 })}
      <div><div><b>${esc(x.name)}</b> ${why} e riceve:</div>
      <div class="award-chip"><span class="chip on">${POWERUPS[x.type].label}</span></div>
      <div class="muted hint">${esc(POWERUPS[x.type].desc)}</div></div></div>`;
    const ranking = view.players.filter((p) => p.connected).slice().sort((x, y) => y.sessionPoints - x.sessionPoints)
      .map((p) => `${esc(p.name)} ${p.sessionPoints}`).join(' · ');
    $('awardBox').innerHTML = (a.first ? `<div class="muted">🏃 ${esc(a.first.name)} ha finito per primo: bonus +${a.first.bonus}</div>` : '')
      + (a.winner ? line(a.winner, `ha vinto la sessione con ${a.winner.points} punti`) : '<div class="muted">Nessuno ha scelto la risposta sbagliata: niente power-up per la sessione.</div>')
      + (a.last ? line(a.last, 'ha meno punti in classifica') : '')
      + `<div class="muted hint">Punti della sessione: ${ranking}</div>`;
  }

  function renderBoard(el, withDelta) {
    el.innerHTML = view.players.map((p, i) => `
      <div class="line ${p.id === view.you ? 'me' : ''}">
        <div class="pos">${i + 1}</div>
        <div class="who-cell">${avatar(p)}<span class="name">${esc(p.name)}${p.connected ? '' : ' <span class="muted">(offline)</span>'}${
          (p.powerups || []).length ? ` <span class="pw-mini">${p.powerups.map((t) => POWERUPS[t].label).join(' ')}</span>` : ''}</span></div>
        <div class="delta ${p.lastPoints ? '' : 'zero'}">${withDelta ? (p.lastPoints ? '+' + p.lastPoints : '+0') : p.correctCount + ' ✓'}</div>
        <div class="pts">${p.score}</div>
      </div>`).join('');
  }

  function renderFinal() {
    show('final');
    renderedKey = '';
    const [p1, p2, p3] = view.players;
    const tied = view.players.filter((p) => p.score === p1.score);
    $('quitNote').classList.toggle('hidden', !view.quitEnded);
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
    if (view && view.quit && view.quit.votes) updateQuitInfo();
    if (view && view.state === 'click') updateClick();
    if (view && view.state === 'song') updateSongStatus();
    if (view && deadline != null) {
      const left = Math.max(0, deadline - performance.now());
      if (view.state === 'question') {
        const ratio = left / view.questionTime;
        const bar = $('timerBar');
        bar.style.transform = `scaleX(${ratio})`;
        bar.style.backgroundPosition = `${ratio * 100}% 0`;
        $('qTime').textContent = Math.ceil(left / 1000) + 's';
        // tempo dimezzato da un avversario e scaduto: le risposte non sono più cliccabili
        if (left === 0 && view.slowed && view.yourAnswer == null && !$('answers').classList.contains('expired')) {
          $('answers').classList.add('expired');
          for (const btn of $('answers').querySelectorAll('.answer')) btn.disabled = true;
          $('qStatus').textContent = 'Tempo dimezzato da un avversario: scaduto!';
        }
      } else if (view.state === 'guess' && view.guess) {
        const ratio = left / view.guess.duration;
        $('gTimerBar').style.transform = `scaleX(${ratio})`;
        $('gTimerBar').style.backgroundPosition = `${ratio * 100}% 0`;
        $('gTime').textContent = Math.ceil(left / 1000) + 's';
        guessTiles(performance.now() - guessStartLocal);
      } else if (view.state === 'wsession' && view.ws && !view.ws.done) {
        const ratio = left / view.ws.time;
        $('wsTimerBar').style.transform = `scaleX(${ratio})`;
        $('wsTimerBar').style.backgroundPosition = `${ratio * 100}% 0`;
        $('wsTime').textContent = Math.ceil(left / 1000) + 's';
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

  // ---------- power-up: uso e legenda ----------
  $('powerBar').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip.power');
    if (!btn || btn.disabled || !view || view.usedPower) return;
    sendAction({ t: 'power', type: btn.dataset.type });
  });
  $('legendList').innerHTML = Object.values(POWERUPS).map((p) => `<div class="legend-row"><span class="chip on">${p.label}</span><span>${esc(p.desc)}</span></div>`).join('');
  $('legendBtn').onclick = () => $('legend').classList.toggle('hidden');

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
