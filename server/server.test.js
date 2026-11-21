// Tests for the relay. Each test starts its own relay on a free port; catseye reports go to a list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, GRACE, PRESETS } from './server.js';

const BUTTONS = [
  { seat: 1, label: 'Go ahead', color: '#1d9e75' },
  { seat: 2, label: 'I know', color: '#7F77DD' },
  { seat: 2, label: 'Next', color: '#D85A30' },
];

async function start(t) {
  let clock = 1_000_000;
  const reports = [];
  const relay = createRelay({ now: () => clock, report: (name, data) => reports.push({ name, data }) });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  const streams = [];
  t.after(() => { streams.forEach(s => s.close()); relay.server.closeAllConnections(); relay.server.close(); });
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
  // Opens a room's event stream; `next(type)` waits for the next event of that type.
  async function listen(code, token) {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/v1/rooms/${code}/events?token=${token}`, { signal: ctrl.signal });
    if (res.status !== 200) return { status: res.status };
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    const queue = [];
    async function next(type) {
      for (;;) {
        const i = queue.findIndex(e => e.type === type);
        if (i >= 0) return queue.splice(i, 1)[0].data;
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += value;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type) queue.push({ type, data: JSON.parse(data) });
        }
      }
    }
    const stream = { status: 200, next, queue, close: () => ctrl.abort() };
    streams.push(stream);
    return stream;
  }
  async function room(code = 'KITE') {
    const host = await (await post('/v1/rooms', { code, name: 'Alex', buttons: BUTTONS, preset: 'crossword' })).json();
    const guest = await (await post(`/v1/rooms/${code}/join`, { name: 'Sam' })).json();
    return { host, guest };
  }
  return { relay, base, post, listen, room, reports, tick: ms => { clock += ms; relay.tick(); } };
}

test('health and presets', async t => {
  const { base } = await start(t);
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
  assert.deepEqual(await (await fetch(`${base}/v1/presets`)).json(), PRESETS);
});

test('create a room and join it; a third person is turned away', async t => {
  const { post, reports } = await start(t);
  const made = await post('/v1/rooms', { code: 'kite', name: ' Alex ', buttons: BUTTONS });
  assert.equal(made.status, 201);
  assert.equal((await made.json()).seat, 1);
  assert.equal((await post('/v1/rooms', { code: 'KITE', name: 'Other', buttons: [] })).status, 409);
  const joined = await post('/v1/rooms/KITE/join', { name: 'Sam' });
  assert.equal(joined.status, 200);
  assert.equal((await joined.json()).seat, 2);
  assert.equal((await post('/v1/rooms/KITE/join', { name: 'Third' })).status, 409);
  assert.equal((await post('/v1/rooms/NOPE/join', { name: 'Sam' })).status, 404);
  assert.deepEqual(reports.map(r => r.name), ['room_created', 'room_joined']);
  assert.deepEqual(reports[0].data, { preset: 'none', buttons: 3 });
});

test('bad rooms are refused', async t => {
  const { post } = await start(t);
  const bad = [
    { code: 'KIT', name: 'Alex', buttons: [] },
    { code: 'KITE', name: '', buttons: [] },
    { code: 'KITE', name: 'x'.repeat(21), buttons: [] },
    { code: 'KITE', name: 'Alex', buttons: [{ seat: 3, label: 'Hi', color: '#000000' }] },
    { code: 'KITE', name: 'Alex', buttons: [{ seat: 1, label: 'Hi', color: 'red' }] },
    { code: 'KITE', name: 'Alex', buttons: [{ seat: 1, label: ' ', color: '#000000' }] },
    { code: 'KITE', name: 'Alex', buttons: Array(13).fill({ seat: 1, label: 'Hi', color: '#000000' }) },
  ];
  for (const body of bad) assert.equal((await post('/v1/rooms', body)).status, 400, JSON.stringify(body).slice(0, 80));
});

test('a press lights up only on the other phone', async t => {
  const { post, listen, room } = await start(t);
  const { host, guest } = await room();
  const hostStream = await listen('KITE', host.token);
  const guestStream = await listen('KITE', guest.token);
  const { buttons, seats } = await guestStream.next('state');
  assert.equal(seats.length, 2);
  const iKnow = buttons.find(b => b.label === 'I know');

  assert.equal((await post('/v1/rooms/KITE/press', { token: guest.token, id: iKnow.id })).status, 204);
  assert.deepEqual(await hostStream.next('press'), { id: iKnow.id });
  // Only the button's own seat can press it.
  assert.equal((await post('/v1/rooms/KITE/press', { token: host.token, id: iKnow.id })).status, 400);
  assert.equal((await post('/v1/rooms/KITE/press', { token: 'nope', id: iKnow.id })).status, 404);
  // Let any stray events arrive, then check the guest never got its own press.
  await post('/v1/rooms/KITE/press', { token: host.token, id: buttons.find(b => b.seat === 1).id });
  await guestStream.next('press');
  assert.equal(guestStream.queue.filter(e => e.type === 'press').length, 0);
});

test('anyone can change the buttons, and both phones see it', async t => {
  const { post, listen, room } = await start(t);
  const { host, guest } = await room();
  const hostStream = await listen('KITE', host.token);
  await hostStream.next('state');
  const fresh = [{ seat: 1, label: 'Wait', color: '#378ADD' }, { seat: 2, label: 'Got it', color: '#639922' }];
  assert.equal((await post('/v1/rooms/KITE/buttons', { token: guest.token, buttons: fresh })).status, 204);
  const { buttons } = await hostStream.next('state');
  assert.deepEqual(buttons.map(({ seat, label, color }) => ({ seat, label, color })), fresh.map(b => ({ ...b, color: b.color.toUpperCase() })));
  assert.equal((await post('/v1/rooms/KITE/buttons', { token: guest.token, buttons: 'no' })).status, 400);
});

test('state says who is connected', async t => {
  const { listen, room } = await start(t);
  const { host, guest } = await room();
  const hostStream = await listen('KITE', host.token);
  let { seats } = await hostStream.next('state');
  assert.deepEqual(seats.map(s => [s.name, s.here]), [['Alex', true], ['Sam', false]]);
  const guestStream = await listen('KITE', guest.token);
  ({ seats } = await hostStream.next('state'));
  assert.deepEqual(seats.map(s => s.here), [true, true]);
  guestStream.close();
  ({ seats } = await hostStream.next('state'));
  assert.deepEqual(seats.map(s => s.here), [true, false]);
});

test('a disconnected seat is kept for the grace period, then freed; an empty room closes', async t => {
  const { post, listen, room, tick, relay, reports } = await start(t);
  const { host, guest } = await room();
  const hostStream = await listen('KITE', host.token);
  await hostStream.next('state');
  tick(GRACE - 1000);
  assert.equal(relay.rooms.get('KITE').seats.size, 2);
  tick(2000);   // the guest never connected: freed. The host is connected: kept.
  const { seats } = await hostStream.next('state');
  assert.deepEqual(seats.map(s => s.name), ['Alex']);
  assert.equal((await post('/v1/rooms/KITE/join', { name: 'Kim' })).status, 200);   // the seat is open again
  assert.equal((await listen('KITE', guest.token)).status, 404);                   // the old token is gone

  hostStream.close();
  await new Promise(r => setTimeout(r, 50));
  tick(GRACE + 1000);
  assert.equal(relay.rooms.has('KITE'), false);
  assert.equal(reports.at(-1).name, 'room_closed');
  assert.equal(reports.at(-1).data.presses, 0);
});

test('leaving frees the seat at once', async t => {
  const { post, listen, room, relay } = await start(t);
  const { host, guest } = await room();
  const hostStream = await listen('KITE', host.token);
  await hostStream.next('state');
  assert.equal((await post('/v1/rooms/KITE/leave', { token: guest.token })).status, 204);
  const { seats } = await hostStream.next('state');
  assert.deepEqual(seats.map(s => s.name), ['Alex']);
  await post('/v1/rooms/KITE/leave', { token: host.token });
  assert.equal(relay.rooms.has('KITE'), false);
});

test('only the site\'s own pages get CORS', async t => {
  const { base } = await start(t);
  const ours = await fetch(`${base}/health`, { headers: { origin: 'https://adgnvtefc.github.io' } });
  assert.equal(ours.headers.get('access-control-allow-origin'), 'https://adgnvtefc.github.io');
  const theirs = await fetch(`${base}/health`, { headers: { origin: 'https://example.com' } });
  assert.equal(theirs.headers.get('access-control-allow-origin'), null);
});
