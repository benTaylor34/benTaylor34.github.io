/* Spotify now-playing proxy for the homepage.

   GET /  ->  { status, title, artist, url, cover, durationMs, progressMs, playedAt, fetchedAt, limited? }
     status: "playing" | "paused" | "last" | "none"

   Keeps the Spotify refresh token and client secret server-side (Worker secrets),
   and mirrors the desktop visualiser's logic: current playback if there is any,
   otherwise the most recently played track.

   Daily cap: every request is counted by the Quota Durable Object. Once DAILY_LIMIT is
   reached (resets at midnight UTC) the worker stops calling Spotify and answers with the
   last song it saw, marked `limited: true`, which tells the page to stop polling.

   Secrets:  SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN
   Var:      ALLOWED_ORIGINS (comma separated)
*/

import { DurableObject } from 'cloudflare:workers';

// Cloudflare's free plan allows 100,000 Worker and 100,000 Durable Object requests a day.
// Capped requests still count, so this leaves room for visitors who arrive after the cap.
const DAILY_LIMIT = 50000;
const API = 'https://api.spotify.com/v1';
const CACHE_SECONDS = 5; // shared across visitors so we stay well under Spotify's rate limits

let memToken = null; // { value, expires }, survives between requests on a warm isolate

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

    const quota = env.QUOTA.get(env.QUOTA.idFromName('global'));
    const { ok, last, lastAt } = await quota.take(DAILY_LIMIT);
    if (!ok) {
      // over the cap: no Spotify call, just the last song as a "last played" card
      return json(last ? { ...last, status: 'last', progressMs: 0, limited: true } : { status: 'none', limited: true });
    }
    if (last && Date.now() - lastAt < CACHE_SECONDS * 1000) return json(last);

    try {
      const body = await nowPlaying(env);
      ctx.waitUntil(quota.remember(body));
      return json(body);
    } catch (err) {
      return json({ status: 'error', message: String(err.message || err) }, 502);
    }
  },
};

// ---------------------------------------------------------------- daily cap
// One global instance: counts today's requests and remembers the latest song.
export class Quota extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.day = (await ctx.storage.get('day')) || '';
      this.count = (await ctx.storage.get('count')) || 0;
      this.last = (await ctx.storage.get('last')) || null;
      this.lastAt = 0; // in memory only: a restart just means one extra Spotify call
    });
  }

  async take(limit) {
    const today = new Date().toISOString().slice(0, 10); // UTC
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
      await this.ctx.storage.put('day', today);
    }
    const ok = this.count < limit;
    if (ok) {
      this.count++;
      await this.ctx.storage.put('count', this.count);
    }
    return { ok, last: this.last, lastAt: this.lastAt };
  }

  async remember(body) {
    if (!body || !body.title) return;
    const changed = !this.last || this.last.title !== body.title || this.last.status !== body.status;
    this.last = body;
    this.lastAt = Date.now();
    if (changed) await this.ctx.storage.put('last', body); // only write when the song/state changes
  }
}

// ---------------------------------------------------------------- auth
// Access tokens last an hour; keep one in memory / the edge cache rather than refreshing per request.
async function accessToken(env) {
  if (memToken && memToken.expires > Date.now()) return memToken.value;
  const key = new Request('https://token.internal/spotify-access-token');
  const hit = await caches.default.match(key);
  if (hit) return hit.text();

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.SPOTIFY_REFRESH_TOKEN }),
  });
  if (!res.ok) throw new Error(`token refresh failed (${res.status})`);
  const tok = await res.json();
  const ttl = Math.max(60, (tok.expires_in || 3600) - 120);
  memToken = { value: tok.access_token, expires: Date.now() + ttl * 1000 };
  await caches.default.put(key, new Response(tok.access_token, { headers: { 'Cache-Control': `max-age=${ttl}` } }));
  return tok.access_token;
}

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

async function nowPlaying(env) {
  const token = await accessToken(env);
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
