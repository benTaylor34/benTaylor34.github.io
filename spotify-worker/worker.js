/* Spotify now-playing proxy for the homepage.

   GET /  ->  { status, title, artist, url, cover, durationMs, progressMs, playedAt, fetchedAt, limited? }
     status: "playing" | "paused" | "last" | "none"

   Mirrors the desktop visualiser's logic: current playback if there is any, otherwise the
   most recently played track. Login uses PKCE like the desktop app, so there's no client
   secret: setup.py logs in once and stores the refresh token as a Worker secret.

   The Store Durable Object is the single global place for state:
   - Daily cap: every request is counted. Once DAILY_LIMIT is reached (resets at midnight UTC)
     the worker stops calling Spotify and answers with the last song it saw, marked
     `limited: true`, which tells the page to stop polling.
   - Login: Spotify may hand out a new refresh token on each refresh, so the current one is
     kept here, and refreshes happen one at a time.

   Secret:  SPOTIFY_REFRESH_TOKEN   (set by setup.py)
   Vars:    SPOTIFY_CLIENT_ID, ALLOWED_ORIGINS   (wrangler.toml)
*/

import { DurableObject } from 'cloudflare:workers';

// Cloudflare's free plan allows 100,000 Worker and 100,000 Durable Object requests a day.
// Capped requests still count, so this leaves room for visitors who arrive after the cap.
const DAILY_LIMIT = 50000;
const API = 'https://api.spotify.com/v1';
const CACHE_SECONDS = 5; // shared across visitors so we stay well under Spotify's rate limits

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      Vary: 'Origin',
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    const store = env.STORE.get(env.STORE.idFromName('global'));
    const { ok, last, fresh, token, error } = await store.take(DAILY_LIMIT, CACHE_SECONDS * 1000);
    if (!ok) {
      // over the cap: no Spotify call, just the last song as a "last played" card
      return json(last ? { ...last, status: 'last', progressMs: 0, limited: true } : { status: 'none', limited: true });
    }
    if (fresh) return json(last);
    if (error) return json({ status: 'error', message: error }, 502);

    try {
      const body = await nowPlaying(token);
      ctx.waitUntil(store.remember(body));
      return json(body);
    } catch (err) {
      return json({ status: 'error', message: String(err.message || err) }, 502);
    }
  },
};

// ---------------------------------------------------------------- shared state
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.day = (await ctx.storage.get('day')) || '';
      this.count = (await ctx.storage.get('count')) || 0;
      this.last = (await ctx.storage.get('last')) || null;
      this.auth = (await ctx.storage.get('auth')) || null; // { seed: hash of the secret, token }
      // in memory only: a restart just means one extra Spotify call / token refresh
      this.lastAt = 0;
      this.access = null; // { value, expires }
      this.refreshing = null;
    });
  }

  // Counts the request. If it's allowed and the cached song is stale, also hands back an access token.
  async take(limit, maxAge) {
    const today = new Date().toISOString().slice(0, 10); // UTC
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
      await this.ctx.storage.put('day', today);
    }
    if (this.count >= limit) return { ok: false, last: this.last };
    this.count++;
    await this.ctx.storage.put('count', this.count);

    if (this.last && Date.now() - this.lastAt < maxAge) return { ok: true, last: this.last, fresh: true };
    try {
      return { ok: true, token: await this.accessToken() };
    } catch (err) {
      return { ok: true, error: String(err.message || err) };
    }
  }

  async remember(body) {
    if (!body || !body.title) return;
    const changed = !this.last || this.last.title !== body.title || this.last.status !== body.status;
    this.last = body;
    this.lastAt = Date.now();
    if (changed) await this.ctx.storage.put('last', body); // only write when the song/state changes
  }

  // Access tokens last an hour. Only one refresh runs at a time, since each may rotate the refresh token.
  async accessToken() {
    if (this.access && this.access.expires > Date.now()) return this.access.value;
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async refresh() {
    const secret = this.env.SPOTIFY_REFRESH_TOKEN;
    if (!secret) throw new Error('not set up yet: run setup.bat');
    // Re-running setup.py sets a new secret, which replaces whatever token we had rotated to.
    const seed = await sha256(secret);
    const current = this.auth && this.auth.seed === seed ? this.auth.token : secret;

    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current, client_id: this.env.SPOTIFY_CLIENT_ID }),
    });
    if (!res.ok) throw new Error(`token refresh failed (${res.status}): run setup.bat again`);
    const tok = await res.json();
    if (tok.refresh_token && tok.refresh_token !== current) {
      this.auth = { seed, token: tok.refresh_token };
      await this.ctx.storage.put('auth', this.auth);
    }
    this.access = { value: tok.access_token, expires: Date.now() + ((tok.expires_in || 3600) - 120) * 1000 };
    return this.access.value;
  }
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- spotify
async function spotify(token, path) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Spotify ${path} -> ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- data
// Normalises a track or podcast episode (same as the desktop app's _item_info).
function itemInfo(item) {
  const episode = item.type === 'episode';
  const images = (episode ? item.images || item.show?.images : item.album?.images) || [];
  return {
    title: item.name || '',
    artist: episode ? item.show?.name || '' : (item.artists || []).map((a) => a.name).join(', '),
    url: item.external_urls?.spotify || '',
    // pick the ~300px image: big enough for the panel, smaller than the 640px original
    cover: (images.find((i) => i.width && i.width <= 320) || images[0] || {}).url || '',
    durationMs: item.duration_ms || 0,
  };
}

async function nowPlaying(token) {
  const fetchedAt = Date.now();

  const player = await spotify(token, '/me/player?additional_types=episode');
  if (player && player.item) {
    return {
      status: player.is_playing ? 'playing' : 'paused',
      ...itemInfo(player.item),
      progressMs: player.progress_ms || 0,
      playedAt: player.is_playing ? new Date(fetchedAt).toISOString() : new Date(player.timestamp || fetchedAt).toISOString(),
      fetchedAt,
    };
  }

  const recent = await spotify(token, '/me/player/recently-played?limit=1');
  const last = recent?.items?.[0];
  if (last) {
    return { status: 'last', ...itemInfo(last.track), progressMs: 0, playedAt: last.played_at, fetchedAt };
  }
  return { status: 'none', fetchedAt };
}
