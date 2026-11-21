// server/server.js: the relay. Passes button presses between the phones in a room.
//
// A room has a 4-letter code, two seats, and a list of buttons. Each button belongs to one seat:
// only that seat can press it, and pressing it lights its light on the other seat's phone.
// Everything lives in memory. Nothing is written to disk; a restart closes every room.
//
// Every POST body is JSON sent as text/plain, so browsers send it without a CORS preflight.
//   GET  /health                      → 200 ok
//   GET  /v1/presets                  → [{id, name, buttons}]
//   POST /v1/rooms                    {code, name, buttons, preset?} → 201 {seat: 1, token}, 409 code taken
//   POST /v1/rooms/<code>/join        {name} → 200 {seat, token}, 404 no room, 409 full
//   GET  /v1/rooms/<code>/events?token=…   a Server-Sent Events stream: `state` whenever the room
//                                     changes, `press` {id} when another seat presses a button
//   POST /v1/rooms/<code>/press       {token, id} → 204 (only your own seat's buttons)
//   POST /v1/rooms/<code>/buttons     {token, buttons} → 204, replaces the whole list (anyone can edit)
//   POST /v1/rooms/<code>/leave       {token} → 204, frees your seat now
//
// A seat whose phone loses its connection is kept for GRACE, so a locked screen or a reload
// doesn't lose it. A room with no seats left closes.
//
// Public through Tailscale Funnel at /red-string (Funnel strips that prefix).
// Reports room_created, room_joined and room_closed to catseye: no names, codes or labels.

import { createServer, request } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const PRESETS = JSON.parse(readFileSync(new URL('./presets.json', import.meta.url), 'utf8'));
export const SEATS = [1, 2];
export const LIMITS = { name: 20, label: 24, perSeat: 12, rooms: 500, body: 8192 };
export const GRACE = 2 * 60_000;
const ROOM = /^\/v1\/rooms\/([A-Z]{4})\/(join|events|press|buttons|leave)$/;
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const ORIGINS = new Set(['https://adgnvtefc.github.io', 'http://localhost:4181', 'http://127.0.0.1:4181',
  ...(process.env.RED_STRING_ORIGINS ?? '').split(',').filter(Boolean)]);

// Send one event to catseye in the background: catseye being slow or down never affects a room.
export function catseyeReporter(url) {
  return (name, data, origin) => {
    const req = request(url, { method: 'POST', timeout: 5000, headers: { 'content-type': 'text/plain', ...(origin && { origin }) } });
    req.on('response', res => res.resume());
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', e => console.warn(`catseye report failed: ${e.message}`));
    req.end(JSON.stringify({ site: 'red-string', name, data }));
  };
}

// At most `max` hits in any rolling window (same as loveletter's).
function limiter(max, windowMs) {
  const hits = new Array(max).fill(-Infinity);
  let oldest = 0;
  return now => {
    if (now - hits[oldest] < windowMs) return false;
    hits[oldest] = now;
    oldest = (oldest + 1) % max;
    return true;
  };
}

// The body as JSON, or null if it's too big or not JSON.
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.body) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { return null; }
}

const text = (value, max) => {
  if (typeof value !== 'string') return null;
  const t = value.trim().replace(/\s+/g, ' ');
  return t && t.length <= max ? t : null;
};

// A checked copy of a button list from a phone, or null if anything in it is off.
export function cleanButtons(list) {
  if (!Array.isArray(list)) return null;
  const perSeat = new Map();
  const out = [];
  for (const b of list) {
    const label = text(b?.label, LIMITS.label);
    if (!SEATS.includes(b?.seat) || !label || !COLOR.test(b?.color ?? '')) return null;
    perSeat.set(b.seat, (perSeat.get(b.seat) ?? 0) + 1);
    if (perSeat.get(b.seat) > LIMITS.perSeat) return null;
    out.push({ seat: b.seat, label, color: b.color.toUpperCase() });
  }
  return out;
}

export function createRelay({ now = Date.now, report = () => {} } = {}) {
  const rooms = new Map();
  const canCreate = limiter(60, 10 * 60_000);   // new rooms, everyone together
  const canJoin = limiter(240, 60_000);         // slows down anyone guessing codes

  const sameToken = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const seatOf = (room, token) => [...room.seats.values()].find(s => sameToken(token, s.token));

  function takeSeat(room, number, name) {
    const seat = { number, name, token: randomBytes(16).toString('hex'), streams: new Set(), goneSince: now() };
    room.seats.set(number, seat);
    return seat;
  }

  function setButtons(room, buttons) {
    room.buttons = buttons.map(b => ({ id: `b${room.nextId++}`, ...b }));
  }

  const state = room => ({
    code: room.code,
    seats: [...room.seats.values()].map(s => ({ seat: s.number, name: s.name, here: s.streams.size > 0 })),
    buttons: room.buttons,
  });

  function send(room, type, data, onlyTo = () => true) {
    const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const seat of room.seats.values()) if (onlyTo(seat)) for (const res of seat.streams) res.write(message);
  }
  const sendState = room => send(room, 'state', state(room));

  function freeSeat(room, seat) {
    for (const res of seat.streams) res.end();
    room.seats.delete(seat.number);
    if (room.seats.size) return sendState(room);
    rooms.delete(room.code);
    report('room_closed', { minutes: Math.round((now() - room.createdAt) / 60_000), presses: room.presses }, room.origin);
  }

  // Run every ~25 s: keeps streams open through proxies, and frees seats gone longer than GRACE.
  function tick() {
    for (const room of [...rooms.values()]) {
      send(room, 'ping', {});
      for (const seat of [...room.seats.values()]) {
        if (!seat.streams.size && now() - seat.goneSince > GRACE) freeSeat(room, seat);
      }
    }
  }

  async function handle(req, res) {
    const origin = ORIGINS.has(req.headers.origin) ? req.headers.origin : undefined;
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
    }
    const done = (status, body) => { res.statusCode = status; res.end(body); };
    const json = (status, value) => { res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); done(status, JSON.stringify(value)); };
    const url = new URL(req.url, 'http://relay');
    const { method } = req;

    if (method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, POST');
      res.setHeader('access-control-max-age', '86400');
      return done(204);
    }
    if (method === 'GET' && url.pathname === '/health') return done(200, 'ok');
    if (method === 'GET' && url.pathname === '/v1/presets') return json(200, PRESETS);

    if (url.pathname === '/v1/rooms') {
      if (method !== 'POST') return done(405);
      const body = await readJson(req);
      const code = typeof body?.code === 'string' && /^[A-Za-z]{4}$/.test(body.code) ? body.code.toUpperCase() : null;
      const name = text(body?.name, LIMITS.name);
      const buttons = cleanButtons(body?.buttons);
      if (!code || !name || !buttons) return done(400);
      if (rooms.has(code)) return done(409);
      if (rooms.size >= LIMITS.rooms || !canCreate(now())) return done(429);
      const room = { code, seats: new Map(), buttons: [], nextId: 1, presses: 0, createdAt: now(), origin };
      setButtons(room, buttons);
      rooms.set(code, room);
      const seat = takeSeat(room, 1, name);
      json(201, { seat: 1, token: seat.token });
      const preset = PRESETS.some(p => p.id === body.preset) ? body.preset : 'none';
      return report('room_created', { preset, buttons: buttons.length }, origin);
    }

    const [, code, action] = ROOM.exec(url.pathname) ?? [];
    if (!code) return done(404);
    const room = rooms.get(code);

    if (action === 'events') {
      if (method !== 'GET') return done(405);
      const seat = room && seatOf(room, url.searchParams.get('token'));
      if (!seat) return done(404);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      res.write('retry: 2000\n\n');
      seat.streams.add(res);
      req.on('close', () => {
        seat.streams.delete(res);
        if (seat.streams.size) return;
        seat.goneSince = now();
        if (room.seats.get(seat.number) === seat) sendState(room);
      });
      return sendState(room);
    }

    if (method !== 'POST') return done(405);
    const body = await readJson(req);
    if (!body) return done(400);

    if (action === 'join') {
      if (!canJoin(now())) return done(429);
      const name = text(body.name, LIMITS.name);
      if (!name) return done(400);
      if (!room) return done(404);
      const open = SEATS.find(n => !room.seats.has(n));
      if (!open) return done(409);
      const seat = takeSeat(room, open, name);
      json(200, { seat: open, token: seat.token });
      sendState(room);
      return report('room_joined', {}, origin);
    }

    const seat = room && seatOf(room, body.token);
    if (!seat) return done(404);

    if (action === 'press') {
      const button = room.buttons.find(b => b.id === body.id);
      if (!button || button.seat !== seat.number) return done(400);
      room.presses++;
      send(room, 'press', { id: button.id }, s => s !== seat);
      return done(204);
    }
    if (action === 'buttons') {
      const buttons = cleanButtons(body.buttons);
      if (!buttons) return done(400);
      setButtons(room, buttons);
      sendState(room);
      return done(204);
    }
    // leave
    freeSeat(room, seat);
    return done(204);
  }

  const server = createServer((req, res) => handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) { res.statusCode = 500; res.end(); }
  }));
  return { server, tick, rooms };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8793);
  const catseye = process.env.CATSEYE_URL ?? 'http://127.0.0.1:8790/v1/e';
  const relay = createRelay({ report: catseyeReporter(catseye) });
  setInterval(relay.tick, 25_000);
  relay.server.listen(port, '127.0.0.1', () => {
    console.log(`red-string relay on http://127.0.0.1:${port} (reporting to ${catseye})`);
  });
}
