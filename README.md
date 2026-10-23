# Il Domandone 🎮📺

Quiz multigiocatore da browser su **anime e videogiochi**, fino a **10 giocatori** collegati insieme.

## Come si gioca

1. Un giocatore crea una stanza e riceve un **codice di 4 lettere** (o un link da condividere).
2. Gli altri entrano con il codice: tutti si ritrovano nella **lobby**.
3. L'host avvia la partita: compaiono **10 domande** estratte a caso, ognuna con **5 risposte**. Solo una è giusta, le altre sono trabocchetti.
4. Hai 20 secondi per rispondere. Se rispondi giusto guadagni da **1000 punti** (risposta istantanea) a **500 punti** (all'ultimo secondo): **più sei veloce, più punti fai**. Una risposta sbagliata vale 0.
5. Dopo ogni domanda vedi la risposta corretta, chi è stato il più veloce e la classifica.
6. Dopo 10 domande chi ha più punti **vince il round**. L'host può avviare un nuovo round o tornare alla lobby.

## Avvio

Serve solo [Node.js](https://nodejs.org) 18 o superiore. Non ci sono dipendenze da installare.

```bash
npm start
# oppure: node server.js
```

Il server mostra gli indirizzi a cui collegarsi:

- `http://localhost:3000` sul computer che ospita il server;
- `http://<ip-del-computer>:3000` per gli altri dispositivi **sulla stessa rete Wi‑Fi** (telefoni, tablet, altri PC).

Per giocare con amici **su Internet** puoi pubblicare il server su un hosting Node (Render, Railway, Fly.io…) oppure esporlo temporaneamente con un tunnel come `cloudflared tunnel --url http://localhost:3000` o `ngrok http 3000`.

La porta si cambia con la variabile d'ambiente `PORT` (es. `PORT=8080 npm start`).

## Struttura

| File | Contenuto |
| --- | --- |
| `server.js` | Server HTTP: stanze, lobby, timer, punteggi. Aggiornamenti in tempo reale tramite Server‑Sent Events. |
| `public/index.html` | Il gioco (HTML + CSS + JS in un unico file). |
| `questions.js` | La banca domande (44 domande). |

## Aggiungere domande

In `questions.js` aggiungi un oggetto con la domanda, la risposta corretta e 4 risposte sbagliate:

```js
{ q: 'Testo della domanda?', a: 'Risposta giusta', w: ['Sbagliata 1', 'Sbagliata 2', 'Sbagliata 3', 'Sbagliata 4'] },
```

L'ordine delle risposte viene mescolato a ogni partita.
