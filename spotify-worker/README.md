# Spotify now-playing worker

Powers the **Now Playing** panel on the homepage. It's a tiny Cloudflare Worker that holds
your Spotify login and returns what you're playing (or last played) as JSON. Same logic and
same Spotify app as the desktop [Spotify Visualiser](https://github.com/benTaylor34/Spotify-Visualiser).

## Setup

You need [Node.js](https://nodejs.org) (LTS) and Python, which the desktop visualiser already uses.

1. Double-click **`setup.bat`**.
2. A browser tab opens for **Cloudflare**: sign up (free, no card) or log in, then click **Allow**.
   This only happens the first time.
3. A browser tab opens for **Spotify**: click **Agree**.
4. If Cloudflare asks you to pick a `workers.dev` name, type one in the setup window.
5. When it says **Working!**, commit and push `index.html`. That's it.

Setup deploys the worker, gives it your Spotify login, and writes the worker's URL into
`NOW_PLAYING_URL` in `../index.html` for you.

There's no client secret. Like the desktop app, it uses PKCE with the client ID in
`wrangler.toml` and the `http://127.0.0.1:8888/callback` redirect the desktop app already uses.

**Run `setup.bat` again** any time you change `worker.js`, or if the panel stops updating
(e.g. you removed the app's access in your Spotify account settings). It's safe to rerun.

Until `NOW_PLAYING_URL` is set, or if the worker can't be reached, the panel shows the
fallback track hard-coded in `index.html`.

## How the bars work

Browsers can't hear Spotify's audio, so the panel picks the best data it has:

1. **Your real bars**: the desktop Spotify Visualiser records every song it hears on your PC.
   Setup connects it to this worker (it adds `site_worker_url` and `site_upload_key` to the app's
   `config.json`), and it uploads a song's recording (~70 KB) once a fifth of it is recorded.
   Songs recorded before this existed upload the next time you play them on the PC.
2. **The song's tempo**: for anything else, the bars pulse at the song's real BPM and size,
   using tempo/energy from [ReccoBeats](https://reccobeats.com) (Spotify blocks this data for new
   apps). Unknown songs use a default tempo. The beat isn't lined up with the real drums.
3. **A gentle wave** when nothing is playing and there's no recording.

## Do I need a Cloudflare account?

Yes, a free one. The panel has to work while your PC is off, and your Spotify login can't
be put in the public website. So something online has to hold it, and every host that can
(Cloudflare, Vercel, Netlify...) needs an account. Cloudflare's free plan is the simplest
fit: no card, and the daily cap below keeps it inside the free limits.

## Daily request cap

`DAILY_LIMIT` in `worker.js` (50,000) caps how many requests the worker answers per day, so it
stays inside Cloudflare's free plan (100,000 Worker + 100,000 Durable Object requests a day).
A small Durable Object (`Store`) counts them. Once the cap is hit, until midnight UTC:

- the worker stops calling Spotify and returns the last song it saw, marked `limited: true`;
- the page shows that song as "Last played", stops polling, and remembers this in
  `localStorage` so reloads and return visits make no requests that day.

## Testing locally

Serve the site with `python -m http.server 8000` from the repo root; `localhost:8000` is already
in `ALLOWED_ORIGINS` in `wrangler.toml`.
