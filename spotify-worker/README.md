# Spotify now-playing worker

Powers the **Now Playing** panel on the homepage. It's a tiny Cloudflare Worker that holds
your Spotify credentials as secrets and returns what you're playing (or last played) as JSON.
Same logic as the desktop [Spotify Visualiser](https://github.com/benTaylor34/Spotify-Visualiser).

## One-time setup

1. **Spotify app.** Use the same app as the desktop visualiser
   (<https://developer.spotify.com/dashboard>). In its **Settings** copy the **Client ID**
   and click **View client secret** to copy the **Client secret**. Make sure
   `http://127.0.0.1:8888/callback` is in the Redirect URIs.
2. **Refresh token.** From this folder run:
   ```bash
   python get_refresh_token.py YOUR_CLIENT_ID YOUR_CLIENT_SECRET
   ```
   Approve access in the browser and copy the token it prints.
3. **Cloudflare.** Make a free account at <https://dash.cloudflare.com/sign-up>, then from this folder:
   ```bash
   npx wrangler login
   npx wrangler secret put SPOTIFY_CLIENT_ID
   npx wrangler secret put SPOTIFY_CLIENT_SECRET
   npx wrangler secret put SPOTIFY_REFRESH_TOKEN
   npx wrangler deploy
   ```
   (Each `secret put` asks you to paste the value. The first one may ask to create the worker; say yes.)
4. `deploy` prints a URL like `https://spotify-now-playing.<you>.workers.dev`. Open it to check
   you get JSON, then paste it into `NOW_PLAYING_URL` in `../index.html`.

Until `NOW_PLAYING_URL` is set (or if the worker is unreachable) the panel shows the
fallback track hard-coded in `index.html`.

## Daily request cap

`DAILY_LIMIT` in `worker.js` (50,000) caps how many requests the worker answers per day, so it
stays inside Cloudflare's free plan (100,000 Worker + 100,000 Durable Object requests a day).
A small Durable Object (`Quota`) counts them. Once the cap is hit, until midnight UTC:

- the worker stops calling Spotify and returns the last song it saw, marked `limited: true`;
- the page shows that song as "Last played", stops polling, and remembers this in
  `localStorage` so reloads and return visits make no requests that day.

## Testing locally

Serve the site with `python -m http.server 8000` from the repo root; `localhost:8000` is already
in `ALLOWED_ORIGINS` in `wrangler.toml`.
