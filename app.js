// app.js: the whole page. Lobby → create room → the room, plus the button editor both screens share.
// The relay (server/server.js) holds every room; this page only shows what it's told.

// Pages on localhost use the local relay; ?relay=<port> points at a throwaway one for testing.
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
const relayPort = new URLSearchParams(location.search).get('relay');
const RELAY = local ? `http://127.0.0.1:${relayPort ?? 8793}` : 'https://hanmos-mac-studio.tail6c4683.ts.net/red-string';

export const PALETTE = ['#E24B4A', '#D85A30', '#EF9F27', '#639922', '#1D9E75', '#378ADD', '#7F77DD', '#D4537E', '#5F5E5A'];
const LIGHT_MS = 2000;
const BLINK_MS = 200;   // how long a lit light goes dark when it's pressed again

const $ = id => document.getElementById(id);
// A small element builder. Text always goes in as text, never as HTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') for (const [prop, value] of Object.entries(v)) el.style.setProperty(prop, value);
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter(c => c != null && c !== false));
  return el;
}

// Browser storage is only a convenience here: your name (kept), and the seat you're in (this tab only),
// so a reload rejoins the room.
const store = key => key === 'seat' ? sessionStorage : localStorage;
const saved = {
  get(key) { try { return JSON.parse(store(key).getItem(`red-string:${key}`)); } catch { return null; } },
  set(key, value) { try { store(key).setItem(`red-string:${key}`, JSON.stringify(value)); } catch {} },
  drop(key) { try { store(key).removeItem(`red-string:${key}`); } catch {} },
};

// POSTs JSON as text/plain, so the browser sends it without a CORS preflight. Gives the status, or 0 offline.
async function post(path, body) {
  try {
    const res = await fetch(RELAY + path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
    return { status: res.status, data: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
  } catch {
    return { status: 0, data: null };
  }
}
const OFFLINE = "Couldn't reach the relay. Check your connection.";

function show(screen) {
  for (const s of ['lobby', 'create', 'room']) $(s).hidden = s !== screen;
  $('sheet').hidden = true;
}

const myName = () => $('name').value.trim().replace(/\s+/g, ' ');
function needName(errorEl) {
  if (myName()) return false;
  errorEl.textContent = 'Enter your name first.';
  $('name').focus();
  return true;
}

// ---- The button editor ----
// Lays out each seat's buttons: tap the dot to pick a color, type to rename, × to remove.
// `titles` names the seats, e.g. {1: 'Seat 1 (you)', 2: 'Seat 2 (whoever joins)'}.
function editor(root, buttons, titles) {
  let list = buttons.map(({ seat, label, color }) => ({ seat, label, color }));
  let open = null;   // the button whose palette is showing

  function render() {
    root.replaceChildren(...[1, 2].map(seat => h('div', {},
      h('p', { class: 'seat-title' }, titles[seat]),
      list.filter(b => b.seat === seat).map(b => h('div', { class: `chip${open === b ? ' open' : ''}`, style: { '--chip-color': b.color } },
        h('div', { class: 'chip-row' },
          h('button', { class: 'swatch', 'aria-label': 'Color', onclick: () => { open = open === b ? null : b; render(); } },
            h('span', { style: { background: b.color } })),
          h('input', { value: b.label, maxlength: 24, 'aria-label': 'Label', oninput: e => { b.label = e.target.value; } }),
          h('button', { class: 'remove', 'aria-label': 'Remove', onclick: () => { list = list.filter(x => x !== b); render(); } }, '×')),
        open === b && h('div', { class: 'palette' }, PALETTE.map(color =>
          h('button', { class: color === b.color ? 'picked' : null, 'aria-label': color, style: { background: color },
            onclick: () => { b.color = color; open = null; render(); } }))))),
      list.filter(b => b.seat === seat).length < 12 && h('button', { class: 'add', onclick: () => {
        const color = PALETTE.find(c => !list.some(b => b.color === c)) ?? PALETTE[list.length % PALETTE.length];
        list.push({ seat, label: 'New button', color });
        render();
        root.querySelectorAll('.chip-row input')[list.filter(b => b.seat <= seat).length - 1]?.select();
      } }, '+ Add button'))));
  }
  render();
  return {
    // The buttons to send, or a message saying what's wrong.
    get() {
      const out = list.map(b => ({ ...b, label: b.label.trim() }));
      return out.some(b => !b.label) ? { error: 'Every button needs a label.' } : { buttons: out };
    },
  };
}

// ---- Lobby ----
$('name').value = saved.get('name') ?? '';
$('name').addEventListener('change', () => saved.set('name', myName()));
const upperLetters = e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); };
$('join-code').addEventListener('input', upperLetters);
$('create-code').addEventListener('input', upperLetters);

$('join').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('lobby-error');
  err.textContent = '';
  if (needName(err)) return;
  const code = $('join-code').value;
  if (code.length !== 4) { err.textContent = 'Room codes are 4 letters.'; return; }
  saved.set('name', myName());
  const { status, data } = await post(`/v1/rooms/${code}/join`, { name: myName() });
  if (status === 200) return enterRoom({ code, ...data });
  err.textContent = { 404: 'No room with that code.', 409: 'That room is full.', 429: 'Too many tries. Wait a minute.', 0: OFFLINE }[status]
    ?? "Couldn't join. Try again.";
});

// ---- Create room ----
let presets = [];
let createEditor = null;
const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), n => String.fromCharCode(65 + (n % 26))).join('');

$('go-create').addEventListener('click', async () => {
  $('lobby-error').textContent = '';
  if (needName($('lobby-error'))) return;
  saved.set('name', myName());
  if (!presets.length) {
    try { presets = await (await fetch(`${RELAY}/v1/presets`)).json(); }
    catch { $('lobby-error').textContent = OFFLINE; return; }
    $('preset').replaceChildren(...presets.map(p => h('option', { value: p.id }, `Preset: ${p.name}`)));
  }
  $('create-code').value = randomCode();
  $('create-error').textContent = '';
  usePreset();
  show('create');
});
function usePreset() {
  const preset = presets.find(p => p.id === $('preset').value) ?? presets[0];
  createEditor = editor($('create-editor'), preset.buttons, { 1: 'Seat 1 (you)', 2: 'Seat 2 (whoever joins)' });
}
$('preset').addEventListener('change', usePreset);
$('reroll').addEventListener('click', () => { $('create-code').value = randomCode(); });
$('create-back').addEventListener('click', () => show('lobby'));

$('open-room').addEventListener('click', async () => {
  const err = $('create-error');
  const code = $('create-code').value;
  const { buttons, error } = createEditor.get();
  if (code.length !== 4) { err.textContent = 'Room codes are 4 letters.'; return; }
  if (error) { err.textContent = error; return; }
  const { status, data } = await post('/v1/rooms', { code, name: myName(), buttons, preset: $('preset').value });
  if (status === 201) return enterRoom({ code, ...data });
  err.textContent = { 409: 'That code is taken. Try another.', 429: 'Too many new rooms right now. Wait a few minutes.', 0: OFFLINE }[status]
    ?? "Couldn't open the room. Try again.";
});

// ---- The room ----
let me = null;        // {code, seat, token}
let room = null;      // the latest state from the relay: {code, seats, buttons}
let stream = null;
let reconnecting = false;
const timers = new WeakMap();   // a showing light or "pressed" text → the timer that hides it

function enterRoom(seat) {
  me = seat;
  saved.set('seat', seat);
  room = null;
  $('room-code').textContent = seat.code;
  $('lights').replaceChildren();
  $('mine').replaceChildren();
  $('said').classList.remove('on');
  renderPresence();
  show('room');
  connect();
}

const eventsUrl = () => `${RELAY}/v1/rooms/${me.code}/events?token=${me.token}`;

function connect() {
  stream?.close();
  stream = new EventSource(eventsUrl());
  stream.addEventListener('state', e => { reconnecting = false; room = JSON.parse(e.data); renderRoom(); });
  stream.addEventListener('press', e => light(JSON.parse(e.data).id));
  stream.addEventListener('error', () => {
    reconnecting = true;
    renderPresence();
    // While CONNECTING, the browser retries by itself. CLOSED can mean the room is gone, but browsers
    // also close streams on reloads and sleeping phones, so ask the relay before giving up the seat.
    if (stream.readyState === EventSource.CLOSED) setTimeout(check, 2000);
  });
}

// Is this seat still there? 404: the room closed or the seat was freed. Anything else: try again.
async function check() {
  if (!me) return;
  const seat = me;
  const ctrl = new AbortController();
  let status = 0;
  try { status = (await fetch(eventsUrl(), { signal: ctrl.signal })).status; } catch {}
  ctrl.abort();
  if (me !== seat) return;
  if (status === 404) return closed('That room has closed.');
  if (status === 200) return connect();
  setTimeout(check, 3000);
}

function closed(message) {
  stream?.close();
  stream = null;
  me = null;
  saved.drop('seat');
  show('lobby');
  $('lobby-error').textContent = message;
}

$('leave').addEventListener('click', () => {
  if (me) post(`/v1/rooms/${me.code}/leave`, { token: me.token });
  closed('');
});

function renderPresence() {
  const el = $('presence');
  const them = room?.seats.find(s => s.seat !== me.seat);
  let line;
  if (reconnecting || !room) line = reconnecting ? 'Reconnecting…' : 'Connecting…';
  else if (!them) line = `Waiting for someone to join with code ${me.code}`;
  else line = them.here ? `${them.name} is here` : `${them.name} lost connection`;
  el.className = `presence${!reconnecting && them?.here ? ' here' : ''}`;
  el.replaceChildren(h('span', { class: 'dot' }), line);
}

function renderRoom() {
  renderPresence();
  const theirs = room.buttons.filter(b => b.seat !== me.seat);
  const mine = room.buttons.filter(b => b.seat === me.seat);
  $('lights').replaceChildren(...(theirs.length
    ? theirs.map(b => h('div', { class: 'light', id: `light-${b.id}`, style: { '--c': b.color } }, h('span', { class: 'dot' }), b.label))
    : [h('p', { class: 'empty' }, 'No buttons on their side yet.')]));
  $('mine').replaceChildren(...(mine.length
    ? mine.map(b => h('button', { class: 'press', style: { '--c': b.color }, onclick: e => press(b, e.currentTarget) }, b.label))
    : [h('p', { class: 'empty' }, 'You have no buttons yet. Tap ✎ to add some.')]));
}

// Shows an element (class `on`) for LIGHT_MS. If it's already showing, it blinks off for BLINK_MS
// first, so every press shows. `update` runs just before it comes on (e.g. to set its text).
function flash(el, update = () => {}) {
  clearTimeout(timers.get(el));
  const on = () => {
    update();
    el.classList.add('on');
    timers.set(el, setTimeout(() => el.classList.remove('on'), LIGHT_MS));
  };
  if (!el.classList.contains('on')) return on();
  el.classList.remove('on');
  timers.set(el, setTimeout(on, BLINK_MS));
}

// Their press: its light.
function light(id) {
  const el = $(`light-${id}`);
  if (el) flash(el);
}

// Your press: once the relay confirms it, "<label> pressed" above your buttons. If it fails, the button shakes.
async function press(button, el) {
  el.classList.remove('failed');
  el.classList.add('sent');
  setTimeout(() => el.classList.remove('sent'), 150);
  const { status } = await post(`/v1/rooms/${me.code}/press`, { token: me.token, id: button.id });
  if (status === 204) return flash($('said'), () => { $('said').textContent = `${button.label} pressed`; });
  void el.offsetWidth;   // restart the shake animation
  el.classList.add('failed');
}

// ---- The in-room editor ----
let sheetEditor = null;
$('edit').addEventListener('click', () => {
  if (!room) return;
  const name = n => room.seats.find(s => s.seat === n)?.name;
  const title = n => n === me.seat ? `${name(n)} (you)` : name(n) ?? `Seat ${n} (open)`;
  sheetEditor = editor($('sheet-editor'), room.buttons, { 1: title(1), 2: title(2) });
  $('sheet-error').textContent = '';
  $('sheet').hidden = false;
});
$('sheet-cancel').addEventListener('click', () => { $('sheet').hidden = true; });
$('sheet-save').addEventListener('click', async () => {
  const { buttons, error } = sheetEditor.get();
  if (error) { $('sheet-error').textContent = error; return; }
  const { status } = await post(`/v1/rooms/${me.code}/buttons`, { token: me.token, buttons });
  if (status === 204) { $('sheet').hidden = true; return; }
  $('sheet-error').textContent = status === 0 ? OFFLINE : "Couldn't save. Try again.";
});

// ---- Start: back into the room you were in, if it's still open ----
const was = saved.get('seat');
if (was?.code && was?.token) enterRoom(was);
