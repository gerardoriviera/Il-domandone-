# Il Domandone 🎮📺

Quiz multigiocatore da browser su **anime e videogiochi**, fino a **9 giocatori** collegati insieme, ognuno con il suo personaggio.

## Come si gioca

1. Ognuno sceglie un nickname e un'**immagine** tra 9 personaggi (frutta e verdura). Ogni giocatore ha un'immagine diversa: in lobby quelle già prese sono in grigio e si può cambiare la propria.
2. Un giocatore crea una stanza e riceve un **codice di 4 lettere** (o un link da condividere).
3. Gli altri entrano con il codice: tutti si ritrovano nella **lobby**.
4. L'host avvia la partita: compaiono **10 domande** estratte a caso, ognuna con **5 risposte**. Solo una è giusta, le altre sono trabocchetti.
5. Hai 20 secondi per rispondere. Se rispondi giusto guadagni da **1000 punti** (risposta istantanea) a **500 punti** (all'ultimo secondo): **più sei veloce, più punti fai**. Una risposta sbagliata vale 0.
6. Dopo ogni domanda vedi la risposta corretta, chi è stato il più veloce e la classifica.
7. Dopo 10 domande chi ha più punti **vince il round**. L'host può avviare un nuovo round o tornare alla lobby.

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
| `public/questions.js` | La banca domande (44 domande). |
| `public/avatars/` | Le 9 immagini dei giocatori. |
| `public/vendor/mqtt.min.js` | Libreria MQTT.js 5.16.1 (licenza MIT). |
| `server.js` | Piccolo server di file statici per provare il gioco in locale. |
| `netlify.toml` | Configurazione per Netlify. |

## Aggiungere domande

In `public/questions.js` aggiungi un oggetto con la domanda, la risposta corretta e 4 risposte sbagliate:

```js
{ q: 'Testo della domanda?', a: 'Risposta giusta', w: ['Sbagliata 1', 'Sbagliata 2', 'Sbagliata 3', 'Sbagliata 4'] },
```

L'ordine delle risposte viene mescolato a ogni partita.

## Aggiungere immagini

Metti una nuova immagine rotonda in `public/avatars/<nome>.webp` e aggiungi `'<nome>'` alla lista `AVATARS` in cima a `public/app.js`. Il numero massimo di giocatori è pari al numero di immagini, fino a 10.
