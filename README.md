# Il Domandone 🎮📺

Quiz multigiocatore da browser di cultura generale, fino a **9 giocatori** collegati insieme, ognuno con il suo personaggio.

Le domande sono divise in **10 categorie**: geografia e viaggi, storia, scienza e natura, cinema e serie TV, musica, sport, cibo e cucina, anime/fumetti/videogiochi, tecnologia e internet, parole/arte/cultura generale.

## Come si gioca

1. Ognuno sceglie un nickname e un'**immagine** tra 9 personaggi (frutta e verdura). Ogni giocatore ha un'immagine diversa: in lobby quelle già prese sono in grigio e si può cambiare la propria.
2. Un giocatore crea una stanza e riceve un **codice di 4 lettere** (o un link da condividere). Gli altri entrano con il codice e si ritrovano nella **lobby**.
3. In lobby ogni giocatore **scrive una sua domanda** con 4 risposte, di cui una sola giusta, poi preme "Sono pronto!". Chi non ha idee può premere **"Genera"**: i campi si riempiono con una domanda già pronta, che si può modificare.
4. L'host avvia la partita. Un round ha **5 domande per ogni giocatore** (es. 3 giocatori = 15 domande), estratte a caso tra le 10 categorie. Ogni domanda ha sempre **4 risposte**, una sola giusta. Attenzione: a volte le risposte sbagliate sono molto simili a quella giusta (es. *Canberra* / *Camberra*), per ingannare chi non legge bene!
5. Hai 20 secondi per rispondere. Se rispondi giusto guadagni da **1000 punti** (risposta istantanea) a **500 punti** (all'ultimo secondo): **più sei veloce, più punti fai**. Una risposta sbagliata vale 0.
6. In ogni round escono **le domande scritte da tutti i giocatori**, una dopo ogni 5 domande normali. L'autore non risponde, ma guadagna **250 punti per ogni giocatore che sbaglia**.
7. Chi ha più punti **vince il round**. Chi ne ha fatti meno sceglie la **categoria favorita**, che nel round successivo uscirà circa 3 volte più spesso delle altre.
8. L'host passa al round successivo: i campi della domanda si svuotano e ognuno ne scrive (o genera) una nuova.

## Il Domandone Plus ✨

Nella schermata iniziale si può creare una stanza **Classico** o una stanza **Plus**. Il Plus usa le stesse domande, le stesse categorie e le stesse regole del Classico (domande aggiunte in `public/questions.js` valgono per entrambi), con queste differenze:

- in lobby ogni giocatore sceglie se preparare una **❓ domanda** oppure un **✏️ disegno**: si disegna con il dito o con il mouse in un riquadro e si scrivono 4 risposte a "Che cosa ho disegnato?", segnando quella giusta. Il tasto "Genera" suggerisce cosa disegnare;
- l'autore di una **domanda** guadagna **250 punti per ogni giocatore che sbaglia** (come nel Classico);
- l'autore di un **disegno** guadagna **250 punti per ogni giocatore che indovina**;
- chi indovina una domanda o un disegno di un giocatore prende **200 punti bonus**, oltre ai punti per la velocità.

## Come funziona il collegamento

Il gioco è un **sito statico**: non serve un server tuo sempre acceso.
Il browser di chi crea la stanza (l'host) gestisce la partita, e i messaggi tra host e giocatori passano da un **server ponte MQTT pubblico e gratuito** (EMQX, HiveMQ o Mosquitto, tramite WebSocket sicuro). Se uno di questi server non risponde, il gioco usa automaticamente uno degli altri. Così funziona da qualunque rete: stesso Wi‑Fi, reti diverse, 4G/5G.

Conseguenze pratiche:

- l'host deve **tenere la pagina aperta** (e possibilmente in primo piano) per tutta la partita: se la chiude, la stanza termina per tutti;
- se un altro giocatore ricarica la pagina o perde la connessione per qualche secondo, rientra automaticamente nella partita con il suo punteggio;
- i server ponte sono pubblici: va benissimo per un quiz tra amici, ma non inviare dati personali nei nickname.

## Pubblicare su Netlify

Il repository contiene già `netlify.toml`, che dice a Netlify di pubblicare la cartella `public/`.

- **Da GitHub:** su Netlify scegli *Add new site → Import an existing project*, collega questo repository e conferma. Non serve nessun comando di build.
- **Trascinando i file:** vai su [app.netlify.com/drop](https://app.netlify.com/drop) e trascina la cartella **`public`**.

Poi condividi l'indirizzo del sito (es. `https://il-domandone.netlify.app`) con gli amici. Funziona allo stesso modo su qualsiasi hosting statico (GitHub Pages, Vercel, Cloudflare Pages…).

## Pubblicare su Cloudflare

Il repository contiene già `wrangler.jsonc`, che dice a Cloudflare di pubblicare la cartella `public/` come sito statico.

- **Da GitHub (Workers):** nella dashboard di Cloudflare vai su *Workers & Pages → Create → Import a repository*, scegli questo repository e il branch `claude/quiz-anime-videogiochi`. Lascia vuoto il comando di build e come comando di deploy `npx wrangler deploy`.
- **Da GitHub (Pages):** *Workers & Pages → Create → Pages → Connect to Git*, scegli il repository, preset *None*, comando di build vuoto e cartella di output `public`.
- **Caricando i file:** *Workers & Pages → Create → Pages → Upload assets* e carica la cartella **`public`**.

Ogni modifica caricata su GitHub aggiorna il sito in automatico (con i primi due metodi).

Nelle impostazioni del progetto su Cloudflare il **production branch** deve essere `claude/quiz-anime-videogiochi`, il branch in cui si trova il codice. Se il sito non si aggiorna, controlla anche che l'app *Cloudflare Workers and Pages* su GitHub abbia accesso a questo repository.

## Provarlo in locale

Serve [Node.js](https://nodejs.org) 18 o superiore, senza dipendenze da installare:

```bash
npm start
```

Apri `http://localhost:3000`. Serve comunque una connessione a Internet per raggiungere il server ponte.

## Struttura

| File | Contenuto |
| --- | --- |
| `public/index.html` | Pagina e grafica del gioco. |
| `public/app.js` | Logica di gioco (motore dell'host) e collegamento tra giocatori. |
| `public/questions.js` | Le 10 categorie e la banca domande (2148 domande, oltre 200 per categoria). |
| `public/avatars/` | Le 9 immagini dei giocatori. |
| `public/vendor/mqtt.min.js` | Libreria MQTT.js 5.16.1 (licenza MIT). |
| `server.js` | Piccolo server di file statici per provare il gioco in locale. |
| `netlify.toml` | Configurazione per Netlify. |
| `wrangler.jsonc` | Configurazione per Cloudflare. |

## Aggiungere domande

In `public/questions.js` aggiungi alla categoria giusta un oggetto con la domanda, la risposta corretta e 3 risposte sbagliate:

```js
{ q: "Testo della domanda?", a: "Risposta giusta", w: ["Sbagliata 1", "Sbagliata 2", "Sbagliata 3"] },
```

L'ordine delle risposte viene mescolato a ogni partita e le domande già uscite non si ripetono finché la categoria non è esaurita. Per una nuova categoria aggiungi una voce a `window.CATEGORIES` e una lista con lo stesso `id` in `window.QUESTIONS`.

## Aggiungere immagini

Metti una nuova immagine rotonda in `public/avatars/<nome>.webp` e aggiungi `'<nome>'` alla lista `AVATARS` in cima a `public/app.js`. Il numero massimo di giocatori è pari al numero di immagini, fino a 10.
