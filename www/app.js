/* ركشتي — تطبيق طلب الركشات
 * Vanilla JS + Supabase + Leaflet + Capacitor
 */
(function () {
'use strict';

const C = window.RK_CONFIG;
const Cap = window.Capacitor;
const P = (Cap && Cap.Plugins) || {};
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());

/* ---------- Storage (Preferences على الموبايل) ---------- */
const storage = (isNative && P.Preferences) ? {
  getItem: async (k) => (await P.Preferences.get({ key: k })).value,
  setItem: (k, v) => P.Preferences.set({ key: k, value: v }),
  removeItem: (k) => P.Preferences.remove({ key: k })
} : window.localStorage;

const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storage, detectSessionInUrl: false }
});

/* ---------- State ---------- */
const S = {
  user: null, profile: null, driver: null, settings: null,
  mode: 'rider', stack: [], current: null, unread: {}
};

/* ---------- Utils ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('ar-EG');
const money = (n) => num(n) + ' ج';
const initial = (name) => esc((name || '؟').trim().charAt(0));
const icon = (name, extra = '', style = '') => `<span class="ms ${extra}" style="${style}" aria-hidden="true">${name}</span>`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const timeStr = (d) => new Date(d).toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' });
const dayStr = (d) => {
  const x = new Date(d), t = new Date();
  const y = new Date(); y.setDate(t.getDate() - 1);
  if (x.toDateString() === t.toDateString()) return 'اليوم';
  if (x.toDateString() === y.toDateString()) return 'أمس';
  return x.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });
};
function haversineKm(a, b) {
  const R = 6371, toR = (x) => x * Math.PI / 180;
  const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const roadKm = (a, b) => Math.max(0.3, haversineKm(a, b) * 1.3);
function suggestPrice(km) {
  const st = S.settings || { base_fare: 1800, per_km: 1100 };
  return Math.max(st.base_fare, Math.round((st.base_fare + st.per_km * km) / 100) * 100);
}
const etaMin = (m) => Math.max(1, Math.round((m / 1000) / 18 * 60)); // ~18 كم/س
const distStr = (m) => m < 1000 ? `${num(Math.round(m / 10) * 10)} م` : `${num((m / 1000).toFixed(1))} كم`;
const pointWKT = (lat, lng) => `SRID=4326;POINT(${lng} ${lat})`;
function parsePoint(g) {
  // geography من PostgREST بيرجع GeoJSON أو EWKB hex
  if (!g) return null;
  if (typeof g === 'object' && g.coordinates) return [g.coordinates[1], g.coordinates[0]];
  if (typeof g === 'string' && /^[0-9A-Fa-f]+$/.test(g)) {
    const hex = g, le = hex.substr(0, 2) === '01';
    const readDouble = (off) => {
      const bytes = new Uint8Array(8);
      for (let i = 0; i < 8; i++) bytes[i] = parseInt(hex.substr((off + i) * 2, 2), 16);
      return new DataView(bytes.buffer).getFloat64(0, le);
    };
    const type = parseInt(le ? hex.substr(8, 2) + hex.substr(6, 2) + hex.substr(4, 2) + hex.substr(2, 2) : hex.substr(2, 8), 16);
    const off = (type & 0x20000000) ? 9 : 5;
    return [readDouble(off + 8), readDouble(off)];
  }
  return null;
}

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200);
}
const ERRORS = {
  taken: 'المشوار ده اتاخد خلاص',
  busy: 'عندك مشوار شغال حالياً',
  not_approved: 'حسابك كسواق لسه ما اتوافق عليه',
  no_subscription: 'اشتراكك منتهي — جدّده عشان تستلم مشاوير',
  bad_state: 'العملية دي ما ممكنة في حالة المشوار الحالية',
  forbidden: 'ما عندك صلاحية',
  no_offer: 'العرض ده ما متاح',
  'Invalid login credentials': 'الرقم أو كلمة السر غلط',
  'User already registered': 'الرقم ده مسجّل قبل كده — سجّل دخول',
  'Failed to fetch': 'مشكلة في الاتصال بالإنترنت'
};
function errMsg(e) {
  const m = (e && (e.message || e.error_description)) || String(e);
  for (const k in ERRORS) if (m.includes(k)) return ERRORS[k];
  return 'حصل خطأ: ' + m;
}
async function safe(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, 'success'); return r; }
  catch (e) { console.error(e); toast(errMsg(e), 'error'); return undefined; }
}
async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}
function haptic() { try { P.Haptics && P.Haptics.impact({ style: 'LIGHT' }); } catch (_) {} }

function modal(html, mount) {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  const close = () => o.remove();
  o.addEventListener('click', (e) => { if (e.target === o) close(); });
  document.body.appendChild(o);
  mount && mount(o, close);
  return close;
}
function confirmBox(title, text, okLabel = 'تأكيد', danger = false) {
  return new Promise((res) => {
    modal(`<h2 style="margin:0;font-size:20px">${esc(title)}</h2>
      <p class="muted" style="margin:0;line-height:1.6">${esc(text)}</p>
      <div class="row gap8"><button class="btn ghost" data-no>رجوع</button>
      <button class="btn" data-ok style="${danger ? 'background:var(--red)' : ''}">${esc(okLabel)}</button></div>`,
    (o, close) => {
      $('[data-no]', o).onclick = () => { close(); res(false); };
      $('[data-ok]', o).onclick = () => { close(); res(true); };
    });
  });
}

/* ---------- Geolocation ---------- */
let lastPos = null;
async function getPos(highAccuracy = true) {
  try {
    if (isNative && P.Geolocation) {
      const perm = await P.Geolocation.checkPermissions();
      if (perm.location !== 'granted') {
        const r = await P.Geolocation.requestPermissions();
        if (r.location !== 'granted') throw new Error('perm');
      }
      return await bestFix((cb) => P.Geolocation.watchPosition({ enableHighAccuracy: highAccuracy, timeout: 15000, maximumAge: 0 }, (p, err) => cb(p, err)),
        (id) => P.Geolocation.clearWatch({ id }), highAccuracy);
    }
    return await bestFix((cb) => navigator.geolocation.watchPosition((p) => cb(p), (e) => cb(null, e), { enableHighAccuracy: highAccuracy, timeout: 15000, maximumAge: 0 }),
      (id) => navigator.geolocation.clearWatch(id), highAccuracy);
  } catch (e) {
    if (!lastPos) toast('فعّل خدمة الموقع (GPS) عشان نلقى ليك أقرب ركشة', 'error');
    return lastPos || C.DEFAULT_CENTER;
  }
}

// بنسمع للـ GPS لحدي ما الدقة تبقى كويسة (أو ينتهي الوقت) ونرجع أدق قراءة
let lastAcc = null;
async function bestFix(start, stop, precise) {
  const maxMs = precise ? 7000 : 2500, target = 20;
  return new Promise(async (res, rej) => {
    let best = null, done = false, id = null;
    const finish = () => {
      if (done) return; done = true;
      try { if (id != null) stop(id); } catch (_) {}
      if (best) { lastPos = [best.latitude, best.longitude]; lastAcc = best.accuracy; res(lastPos); } else rej(new Error('nofix'));
    };
    id = await start((p, err) => {
      if (err || !p) return;
      if (!best || p.coords.accuracy < best.accuracy) best = p.coords;
      if (best.accuracy <= target) finish();
    });
    setTimeout(finish, maxMs);
  });
}

/* ---------- Routing (OSRM — شوارع حقيقية، بدون مفتاح) ---------- */
const routeCache = {};
async function getRoute(a, b) {
  const key = [a, b].map(p => p[0].toFixed(4) + ',' + p[1].toFixed(4)).join('|');
  if (routeCache[key]) return routeCache[key];
  try {
    const u = `${C.ROUTER}/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`;
    const j = await (await fetch(u)).json();
    const r = j.routes && j.routes[0];
    if (!r) throw new Error('noroute');
    // سرعة الركشة في المدينة أبطأ من العربية
    const out = { coords: r.geometry.coordinates.map(c => [c[1], c[0]]), km: r.distance / 1000, min: Math.max(1, Math.round(r.duration / 60 * 1.25)), real: true };
    routeCache[key] = out;
    return out;
  } catch (_) {
    const km = roadKm(a, b);
    return { coords: [a, b], km, min: Math.max(1, Math.round(km / 18 * 60)), real: false };
  }
}
const fareFor = (km) => suggestPrice(km);

/* ---------- Geocoding (OSM Nominatim) ---------- */
async function geocode(q) {
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=sd&accept-language=ar&q=${encodeURIComponent(q)}`;
  const r = await fetch(u, { headers: { 'Accept': 'application/json' } });
  const j = await r.json();
  return j.map(x => ({ name: x.display_name.split('،')[0].split(',')[0], full: x.display_name, lat: +x.lat, lng: +x.lon }));
}
async function reverse(lat, lng) {
  try {
    const u = `https://nominatim.openstreetmap.org/reverse?format=json&zoom=17&accept-language=ar&lat=${lat}&lon=${lng}`;
    const j = await (await fetch(u)).json();
    const a = j.address || {};
    const place = a.amenity || a.shop || a.building || a.road || a.pedestrian || a.footway;
    const area = a.neighbourhood || a.quarter || a.residential || a.suburb || a.city_district || a.hamlet || a.village;
    let out = [place, area].filter(Boolean);
    if (out.length < 2 && j.display_name) out = out.concat(j.display_name.split(/[،,]/).map(x => x.trim()).filter(x => x && !out.includes(x) && !/^\d+$/.test(x)).slice(0, 2 - out.length));
    if (!out.length) out = [a.city || a.town || 'موقع على الخريطة'];
    return out.join('، ');
  } catch (_) { return 'موقع على الخريطة'; }
}

/* ---------- Map helpers ---------- */
function makeMap(el, center, zoom = 15) {
  const m = L.map(el, { zoomControl: false, attributionControl: true }).setView(center, zoom);
  const useFallback = sessionStorage.getItem('rk_tiles') === 'fb';
  const layer = L.tileLayer(useFallback ? C.TILES_FALLBACK : C.TILES, { attribution: useFallback ? C.TILES_FALLBACK_ATTR : C.TILES_ATTR, maxZoom: 19 }).addTo(m);
  if (!useFallback) {
    let errs = 0;
    layer.on('tileerror', () => {
      if (++errs === 4) {
        sessionStorage.setItem('rk_tiles', 'fb');
        m.removeLayer(layer);
        L.tileLayer(C.TILES_FALLBACK, { attribution: C.TILES_FALLBACK_ATTR, maxZoom: 19 }).addTo(m);
      }
    });
  }
  return m;
}
const rkIcon = (label) => L.divIcon({
  className: '', iconSize: [label ? 74 : 36, 36], iconAnchor: [18, 18],
  html: label
    ? `<div style="display:flex;align-items:center;gap:6px;background:#fff;border-radius:999px;padding:3px 10px 3px 3px;box-shadow:0 6px 16px rgba(15,26,20,.18);width:max-content;direction:rtl"><span class="mk-rk" style="width:30px;height:30px;border-width:0">${icon('electric_rickshaw', 'f', 'font-size:18px')}</span><b style="font-size:12px">${label}</b></div>`
    : `<div class="mk-rk">${icon('electric_rickshaw', 'f', 'font-size:20px')}</div>`
});
const meIcon = () => L.divIcon({ className: '', iconSize: [20, 20], iconAnchor: [10, 10], html: '<div class="mk-me"></div>' });
const destIcon = () => L.divIcon({ className: '', iconSize: [16, 16], iconAnchor: [8, 8], html: '<div class="mk-dest"></div>' });

/* ---------- Router ---------- */
const subs = [];      // realtime channels للشاشة الحالية
const timers = [];    // intervals للشاشة الحالية
let cleanupFns = [];
function onLeave(fn) { cleanupFns.push(fn); }
function every(ms, fn) { const id = setInterval(fn, ms); timers.push(id); return id; }
let navId = 0;
// أي حدث لحظي بيوصل بعد ما المستخدم غيّر الشاشة بيتجاهل (كان بيرجّع المستخدم للشاشة القديمة)
function channel(name) {
  const id = navId;
  const ch = sb.channel(name + ':' + Math.random().toString(36).slice(2));
  const on = ch.on.bind(ch);
  ch.on = (type, filter, cb) => { on(type, filter, (...x) => { if (navId === id) cb(...x); }); return ch; };
  subs.push(ch); return ch;
}
function teardown() {
  subs.splice(0).forEach(ch => sb.removeChannel(ch));
  timers.splice(0).forEach(clearInterval);
  cleanupFns.splice(0).forEach(fn => { try { fn(); } catch (_) {} });
}
function go(screen, params = {}, opts = {}) {
  teardown();
  navId++;
  if (opts.replace || opts.root) { if (opts.root) S.stack = []; else S.stack.pop(); }
  S.stack.push({ screen, params });
  S.current = { screen, params };
  const app = $('#app');
  app.innerHTML = '';
  const res = Screens[screen](params);
  app.innerHTML = res.html;
  res.mount && res.mount(app);
  window.scrollTo(0, 0);
}
function back() {
  if (S.stack.length <= 1) return false;
  S.stack.pop();
  const prev = S.stack.pop();
  go(prev.screen, prev.params);
  return true;
}
function home() { go(S.mode === 'driver' ? 'driverHome' : 'riderHome', {}, { root: true }); }

function nav(active) {
  const items = S.mode === 'driver'
    ? [['driverHome', 'electric_rickshaw', 'الطلبات'], ['earnings', 'payments', 'دخلي'], ['history', 'receipt_long', 'مشاويري'], ['account', 'person', 'حسابي']]
    : [['riderHome', 'home', 'الرئيسية'], ['history', 'receipt_long', 'مشاويري'], ['account', 'person', 'حسابي']];
  return `<nav class="nav">${items.map(([s, ic, l]) =>
    `<button data-nav="${s}" class="${s === active ? 'on' : ''}" ${s === active ? 'aria-current="page"' : ''}><span class="ic">${icon(ic, s === active ? 'f' : '')}</span>${l}</button>`).join('')}</nav>`;
}
function bindNav(root) {
  $$('[data-nav]', root).forEach(b => b.onclick = () => go(b.dataset.nav, {}, { root: true }));
}
function bindBack(root) { $$('[data-back]', root).forEach(b => b.onclick = () => { if (!back()) home(); }); }

/* ---------- Data loading ---------- */
async function loadMe() {
  const { data: { user } } = await sb.auth.getUser();
  S.user = user;
  if (!user) return;
  const [p, d, st] = await Promise.all([
    sb.from('profiles').select('*').eq('id', user.id).maybeSingle(),
    sb.from('drivers').select('*').eq('id', user.id).maybeSingle(),
    sb.from('app_settings').select('*').eq('id', 1).maybeSingle()
  ]);
  S.profile = p.data; S.driver = d.data; S.settings = st.data;
  const saved = await storage.getItem('rk_mode');
  S.mode = (saved === 'driver' && S.driver) ? 'driver' : 'rider';
}
async function setMode(m) { S.mode = m; await storage.setItem('rk_mode', m); }

async function findActiveTrip() {
  const uid = S.user.id;
  if (S.mode === 'driver') {
    const { data } = await sb.from('trips').select('*').eq('driver_id', uid)
      .in('status', ['accepted', 'arriving', 'arrived', 'in_progress']).order('created_at', { ascending: false }).limit(1);
    return data && data[0];
  }
  const { data } = await sb.from('trips').select('*').eq('rider_id', uid)
    .in('status', ['requested', 'accepted', 'arriving', 'arrived', 'in_progress']).order('created_at', { ascending: false }).limit(1);
  let t = data && data[0];
  if (!t) {
    const { data: jp } = await sb.from('trip_passengers').select('trip_id').eq('rider_id', uid).eq('status', 'joined').order('joined_at', { ascending: false }).limit(3);
    if (jp && jp.length) {
      const { data: jt } = await sb.from('trips').select('*').in('id', jp.map(x => x.trip_id))
        .in('status', ['requested', 'accepted', 'arriving', 'arrived', 'in_progress']).order('created_at', { ascending: false }).limit(1);
      if (jt && jt[0]) return jt[0];
    }
  }
  if (t && t.status === 'requested' && Date.now() - new Date(t.created_at) > 15 * 60000) {
    await rpc('set_trip_status', { p_trip: t.id, p_status: 'cancelled', p_reason: 'expired' }).catch(() => {});
    return null;
  }
  return t;
}
async function routeToActive() {
  const t = await findActiveTrip();
  if (!t) return home();
  if (S.mode === 'driver') return go('driverTrip', { id: t.id }, { root: true });
  if (t.status === 'requested') return go('waiting', { id: t.id }, { root: true });
  return go('tracking', { id: t.id }, { root: true });
}
async function getTrip(id) {
  const { data, error } = await sb.from('trips').select('*').eq('id', id).single();
  if (error) throw error;
  data._pickup = parsePoint(data.pickup); data._dropoff = parsePoint(data.dropoff);
  return data;
}
async function getProfile(id) {
  const { data } = await sb.from('profiles').select('id,full_name,phone,avatar_url,rating_avg,rating_count').eq('id', id).maybeSingle();
  return data || {};
}
async function getDriverPublic(id) {
  const [{ data: d }, p] = await Promise.all([
    sb.from('drivers').select('id,plate_number,vehicle_color,location').eq('id', id).maybeSingle(),
    getProfile(id)
  ]);
  return Object.assign({}, p, d || {}, { _loc: d ? parsePoint(d.location) : null });
}
const STATUS_AR = {
  requested: 'بندوّر ليك على ركشة', accepted: 'السواق قبل الطلب', arriving: 'الركشة جاية ليك',
  arrived: 'الركشة وصلت مكانك', in_progress: 'في الطريق لوجهتك', completed: 'وصلت', cancelled: 'ملغي'
};
const STEP_IDX = { accepted: 1, arriving: 2, arrived: 3, in_progress: 4, completed: 4 };

/* ---------- Driver location broadcaster (عالمي) ---------- */
// بث موقع السواق: مراقبة مستمرة للـ GPS، بنرسل بس لما يتحرك أو كل ١٥ ثانية، ونتجاهل القراءات الضعيفة
const Loc = {
  watchId: null, lastSent: null, lastSentAt: 0, lastGoodAt: 0,
  async start() {
    if (this.watchId != null) return;
    const onFix = (p) => {
      if (!p || !p.coords) return;
      const acc = p.coords.accuracy || 999, pos = [p.coords.latitude, p.coords.longitude], now = Date.now();
      // قراءة ضعيفة: نقبلها بس لو ما جات قراءة كويسة من ٣٠ ثانية
      if (acc > 60 && now - this.lastGoodAt < 30000) return;
      if (acc <= 60) this.lastGoodAt = now;
      lastPos = pos; lastAcc = acc;
      document.dispatchEvent(new CustomEvent('rk-loc', { detail: { pos, acc } }));
      const moved = !this.lastSent || haversineKm(this.lastSent, pos) > 0.015;
      if ((moved && now - this.lastSentAt > 3000) || now - this.lastSentAt > 15000) {
        this.lastSent = pos; this.lastSentAt = now;
        if (S.user) sb.rpc('update_my_location', { lat: pos[0], lng: pos[1] }).then(() => {});
      }
    };
    try {
      if (isNative && P.Geolocation) {
        const perm = await P.Geolocation.checkPermissions();
        if (perm.location !== 'granted') await P.Geolocation.requestPermissions();
        this.watchId = await P.Geolocation.watchPosition({ enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }, (p) => onFix(p));
      } else {
        this.watchId = navigator.geolocation.watchPosition(onFix, () => {}, { enableHighAccuracy: true, maximumAge: 3000 });
      }
    } catch (_) { toast('فعّل خدمة الموقع (GPS)', 'error'); }
  },
  stop() {
    if (this.watchId == null) return;
    try { isNative && P.Geolocation ? P.Geolocation.clearWatch({ id: this.watchId }) : navigator.geolocation.clearWatch(this.watchId); } catch (_) {}
    this.watchId = null; this.lastSent = null;
  }
};

// تحريك العلامة بنعومة بدل القفز
function animateMarker(mk, to, ms = 900) {
  const from = mk.getLatLng(), t0 = performance.now();
  if (Math.abs(from.lat - to[0]) < 1e-7 && Math.abs(from.lng - to[1]) < 1e-7) return;
  if (haversineKm([from.lat, from.lng], to) > 1) return mk.setLatLng(to);
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    mk.setLatLng([from.lat + (to[0] - from.lat) * e, from.lng + (to[1] - from.lng) * e]);
    if (k < 1 && mk._map) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const priceIcon = (label, shared) => L.divIcon({
  className: '', iconSize: [10, 10], iconAnchor: [0, 40],
  html: `<div style="transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;width:max-content">
    <div style="background:var(--ink);color:#fff;border-radius:12px;padding:5px 10px;font:600 12px 'Readex Pro';box-shadow:0 6px 16px rgba(15,26,20,.25);display:flex;align-items:center;gap:4px;direction:rtl">${shared ? icon('group', '', 'font-size:14px;color:var(--yellow)') : ''}${label}</div>
    <div style="width:3px;height:10px;background:var(--ink)"></div><div style="width:12px;height:12px;border-radius:50%;background:var(--blue);border:3px solid #fff;margin-top:-2px"></div></div>`
});

/* ---------- رسم المسار لحظياً ---------- */
function routeFollower(map) {
  const line = L.polyline([], { color: '#0F1A14', weight: 5, opacity: .85 }).addTo(map);
  let lastFrom = null, lastTo = null, info = null;
  return {
    async update(from, to) {
      if (!from || !to) return info;
      const moved = !lastFrom || haversineKm(from, lastFrom) > 0.06 || !lastTo || haversineKm(to, lastTo) > 0.01;
      if (!moved) return info;
      lastFrom = from; lastTo = to;
      info = await getRoute(from, to);
      if (map._dead) return info;
      line.setLatLngs(info.coords);
      return info;
    },
    get info() { return info; }
  };
}

/* ---------- عداد المسافة (للسواق أثناء المشوار) ---------- */
const Meter = {
  trip: null, km: 0, last: null, watchId: null, sendId: null,
  async start(tripId, serverKm) {
    if (this.trip === tripId && this.watchId != null) return;
    this.stop();
    this.trip = tripId;
    const saved = parseFloat(await storage.getItem('rk_meter_' + tripId) || '0');
    this.km = Math.max(saved, +serverKm || 0); this.last = null;
    const onFix = (p) => {
      if (!p || !p.coords || p.coords.accuracy > 35) return;
      const pt = [p.coords.latitude, p.coords.longitude];
      lastPos = pt;
      if (this.last) {
        const d = haversineKm(this.last, pt);
        if (d < 0.012) return;          // ضوضاء GPS
        if (d < 0.6) this.km += d;      // تجاهل القفزات الغريبة
      }
      this.last = pt;
      storage.setItem('rk_meter_' + tripId, String(this.km));
      document.dispatchEvent(new CustomEvent('rk-meter', { detail: this.km }));
    };
    if (isNative && P.Geolocation) this.watchId = await P.Geolocation.watchPosition({ enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }, (p) => onFix(p));
    else this.watchId = navigator.geolocation.watchPosition(onFix, () => {}, { enableHighAccuracy: true, maximumAge: 0 });
    this.sendId = setInterval(() => sb.rpc('update_trip_meter', { p_trip: tripId, p_km: +this.km.toFixed(3) }).then(() => {}), 12000);
  },
  async stop(final) {
    if (this.watchId != null) { try { isNative && P.Geolocation ? P.Geolocation.clearWatch({ id: this.watchId }) : navigator.geolocation.clearWatch(this.watchId); } catch (_) {} }
    if (this.sendId) clearInterval(this.sendId);
    if (final && this.trip) await sb.rpc('update_trip_meter', { p_trip: this.trip, p_km: +this.km.toFixed(3) });
    this.watchId = null; this.sendId = null;
  }
};
function meterHtml(trip, km) {
  const live = fareFor(km);
  return `<div class="card col gap8" style="background:var(--ink);color:#fff">
    <div class="row" style="justify-content:space-between"><span class="row gap4 small" style="color:#C2CCC6">${icon('speed', '', 'font-size:18px;color:var(--yellow)')}العداد</span><span class="small" style="color:#C2CCC6">السعر المتفق عليه ${money(trip.final_price)}</span></div>
    <div class="row" style="justify-content:space-between;align-items:baseline">
      <b style="font-size:28px;color:var(--yellow)" id="mFare">${money(live)}</b>
      <span style="font-size:16px"><b id="mKm">${num(km.toFixed(2))}</b> كم</span></div>
    <span class="small" style="color:#A9B5AE">العداد بيحسب ${money(S.settings?.base_fare || 0)} فتحة + ${money(S.settings?.per_km || 0)} لكل كيلو مقطوع</span></div>`;
}

/* ---------- Image compress + upload ---------- */
function compressImage(file, maxW = 1280, q = 0.8) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxW / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => b ? res(b) : rej(new Error('compress')), 'image/jpeg', q);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}
async function uploadImage(bucket, path, file) {
  const blob = await compressImage(file);
  const { error } = await sb.storage.from(bucket).upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
  if (error) throw error;
  return path;
}

/* =====================================================
   الشاشات
   ===================================================== */
const Screens = {};

/* ---------- Splash ---------- */
Screens.splash = () => ({
  html: `<div class="screen" style="background:var(--yellow);align-items:center;justify-content:center;gap:20px">
    <div class="logo">${icon('electric_rickshaw', 'f', 'font-size:36px;color:var(--yellow)')}</div>
    <div class="spinner" style="border-color:rgba(15,26,20,.15);border-top-color:var(--ink)"></div></div>`
});

/* ---------- Auth ---------- */
Screens.auth = ({ tab = 'login' } = {}) => ({
  html: `<div class="screen scroll" style="background:#fff">
    <div class="hero">
      <svg aria-hidden="true" viewBox="0 0 390 300" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%">
        <g stroke="#F0B800" stroke-width="16" fill="none" stroke-linecap="round"><path d="M-10 70 H 400"/><path d="M-10 200 C 120 180, 260 240, 400 210"/><path d="M120 -10 V 310"/><path d="M300 -10 L 260 310"/></g></svg>
      <div class="logo">${icon('electric_rickshaw', 'f', 'font-size:36px;color:var(--yellow)')}</div>
      <h1>ركشتك جاية<br>لحدي باب بيتك</h1>
      <p>شوف أقرب ركشة، اعرف السعر قبل تركب، وتابعها لحدي ما تصل.</p>
    </div>
    <form class="pad col gap16" id="authForm" style="padding:24px" novalidate>
      <div class="seg" role="tablist">
        <button type="button" role="tab" data-tab="login" class="${tab === 'login' ? 'on' : ''}" aria-selected="${tab === 'login'}">تسجيل دخول</button>
        <button type="button" role="tab" data-tab="signup" class="${tab === 'signup' ? 'on' : ''}" aria-selected="${tab === 'signup'}">حساب جديد</button>
      </div>
      ${tab === 'signup' ? `<div class="field"><label for="fname">اسمك</label><input class="input" id="fname" autocomplete="name" placeholder="الاسم الأول والأخير" required></div>` : ''}
      <div class="field"><label for="phone">رقم الموبايل</label>
        <div class="row gap8" style="direction:ltr">
          <span class="input" style="width:auto;display:flex;align-items:center;font-weight:600;flex-shrink:0">+249</span>
          <input class="input" id="phone" inputmode="tel" autocomplete="tel" placeholder="9X XXX XXXX" style="direction:ltr;font-weight:600;letter-spacing:1px" required>
        </div></div>
      <div class="field"><label for="pass">كلمة السر</label>
        <input class="input" id="pass" type="password" autocomplete="${tab === 'login' ? 'current-password' : 'new-password'}" placeholder="٦ حروف أو أرقام على الأقل" required></div>
      <button class="btn" type="submit" id="authBtn">${tab === 'login' ? 'دخول' : 'إنشاء الحساب'} ${icon('arrow_back')}</button>
      <p class="muted small" style="text-align:center;line-height:1.7;margin:0">بالمتابعة إنت موافق على الشروط وسياسة الخصوصية</p>
    </form></div>`,
  mount(root) {
    $$('[data-tab]', root).forEach(b => b.onclick = () => go('auth', { tab: b.dataset.tab }, { replace: true }));
    $('#authForm', root).onsubmit = async (e) => {
      e.preventDefault();
      let phone = $('#phone').value.replace(/\D/g, '').replace(/^249/, '').replace(/^0/, '');
      const pass = $('#pass').value;
      if (!/^[19]\d{8}$/.test(phone)) return toast('اكتب رقم سوداني صحيح (٩ أرقام)', 'error');
      if (pass.length < 6) return toast('كلمة السر لازم تكون ٦ على الأقل', 'error');
      const email = `249${phone}@${C.EMAIL_DOMAIN}`;
      const btn = $('#authBtn'); btn.disabled = true;
      await safe(async () => {
        if (tab === 'signup') {
          const name = $('#fname').value.trim();
          if (name.length < 2) throw new Error('اكتب اسمك');
          const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { full_name: name, phone: '+249' + phone } } });
          if (error) throw error;
          if (!data.session) throw new Error('الحساب اتعمل لكن محتاج تفعيل — المدير لازم يقفل "Confirm email" في Supabase');
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password: pass });
          if (error) throw error;
        }
        await boot();
      });
      btn.disabled = false;
    };
  }
});

/* ---------- Rider: Home ---------- */
Screens.riderHome = () => {
  let map, meMk, destMk, drivers = [], dest = null, pickup = null, pickupAddr = '', price = 0, km = 0;
  const driverLayer = L.layerGroup();
  return {
    html: `<div class="screen">
      <div id="map" class="map"></div>
      <div class="map-top">
        <div class="loc-box">${icon('location_on', 'f', 'font-size:20px;color:var(--green)')}
          <div class="col grow"><span class="small muted">موقعك الحالي</span><b id="pickAddr" style="font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">بنحدد موقعك…</b></div></div>
        <button class="icon-btn float" id="recenter" aria-label="موقعي">${icon('my_location')}</button>
      </div>
      <div class="sheet" id="sheet">
        <div class="grab"></div>
        <div class="route-box">
          <div class="route-dots"><span class="dot-a"></span><span class="dash"></span><span class="dot-b"></span></div>
          <div class="col grow gap8">
            <span class="muted" style="font-size:14px" id="pickAddr2">موقعك الحالي</span>
            <label for="destIn" class="sr">الوجهة</label>
            <input id="destIn" placeholder="ماشي وين؟ أو دوس على الخريطة" autocomplete="off">
          </div>
        </div>
        <div id="results" class="col gap4"></div>
        <div id="bottom"></div>
      </div>
      </div>${nav('riderHome')}`,
    async mount(root) {
      bindNav(root);
      map = makeMap($('#map'), lastPos || C.DEFAULT_CENTER);
      driverLayer.addTo(map);
      onLeave(() => { map._dead = true; try { map.stop(); map.off(); map.remove(); } catch (_) {} });
      const setPickup = async (p) => {
        pickup = p;
        if (!meMk) {
          meMk = L.marker(p, { icon: meIcon(), zIndexOffset: 1000, draggable: true }).addTo(map);
          if (lastAcc && lastAcc > 15) {
            const c = L.circle(p, { radius: Math.min(lastAcc, 300), color: '#2E90FA', weight: 1, fillOpacity: .08, interactive: false }).addTo(map);
            meMk.on('dragstart', () => c.remove());
          }
          meMk.on('dragend', () => { const ll = meMk.getLatLng(); setPickup([ll.lat, ll.lng]); if (dest) setDest(dest); });
        } else meMk.setLatLng(p);
        pickupAddr = await reverse(p[0], p[1]);
        if (map._dead) return;
        $('#pickAddr') && ($('#pickAddr').textContent = pickupAddr);
        $('#pickAddr2') && ($('#pickAddr2').textContent = pickupAddr);
      };
      const p = await getPos();
      if (map._dead) return;
      map.setView(p, 17);
      setPickup(p);
      if (lastAcc && lastAcc > 40) toast('دقة الموقع ضعيفة — اسحب النقطة الزرقاء لمكانك بالضبط');
      $('#recenter').onclick = async () => { const q = await getPos(); if (map._dead) return; map.setView(q, 16); setPickup(q); };

      const loadDrivers = async () => {
        if (!pickup) return;
        const { data } = await sb.rpc('nearby_drivers', { lat: pickup[0], lng: pickup[1], radius_m: C.SEARCH_RADIUS_M, max_results: 10 });
        if (map._dead) return;
        drivers = data || [];
        driverLayer.clearLayers();
        drivers.forEach(d => L.marker([d.lat, d.lng], { icon: rkIcon(`${num(etaMin(d.distance_m))} د`) }).addTo(driverLayer));
        renderBottom();
      };
      setTimeout(loadDrivers, 600);
      every(10000, loadDrivers);

      let routeLine = null, routeMin = 0, shared = false, seats = 1, openShared = [];
      const cap = () => S.settings?.shared_capacity || 4;
      const pct = () => (S.settings?.shared_extra_pct ?? 25) / 100;
      const setDest = async (d) => {
        dest = d;
        if (!destMk) destMk = L.marker([d.lat, d.lng], { icon: destIcon() }).addTo(map); else destMk.setLatLng([d.lat, d.lng]);
        $('#destIn').value = d.name;
        $('#results').innerHTML = '';
        const r = await getRoute(pickup, [d.lat, d.lng]);
        if (map._dead) return;
        km = r.km; routeMin = r.min;
        price = suggestPrice(km);
        if (routeLine) routeLine.remove();
        routeLine = L.polyline(r.coords, { color: '#0F1A14', weight: 5, opacity: .85 }).addTo(map);
        map.fitBounds(routeLine.getBounds().pad(0.3), { paddingBottomRight: [0, 280] });
        renderBottom();
        const { data: os } = await sb.rpc('open_shared_trips', { plat: pickup[0], plng: pickup[1], dlat: d.lat, dlng: d.lng });
        if (map._dead) return;
        openShared = os || []; renderBottom();
      };
      map.on('click', async (e) => {
        if (!pickup) return;
        const name = await reverse(e.latlng.lat, e.latlng.lng);
        if (map._dead) return;
        setDest({ name, lat: e.latlng.lat, lng: e.latlng.lng });
      });
      let deb;
      $('#destIn').oninput = (e) => {
        clearTimeout(deb);
        const q = e.target.value.trim();
        if (q.length < 3) { $('#results').innerHTML = ''; return; }
        deb = setTimeout(async () => {
          const r = await geocode(q).catch(() => []);
          $('#results').innerHTML = r.length ? r.map((x, i) => `<button class="list-btn" data-i="${i}" style="padding:10px 4px">${icon('location_on', '', 'color:var(--ink3)')}<span class="col grow"><b style="font-size:14px">${esc(x.name)}</b><span class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.full)}</span></span></button>`).join('')
            : `<p class="small muted" style="margin:4px">ما لقينا نتيجة — دوس على مكانك في الخريطة</p>`;
          $$('[data-i]').forEach(b => b.onclick = () => setDest(r[+b.dataset.i]));
        }, 450);
      };

      function renderBottom() {
        const b = $('#bottom'); if (!b) return;
        const near = drivers.length
          ? `<div class="row" style="justify-content:space-between"><h2 style="margin:0;font-size:17px">${dest ? 'السعر المقترح' : 'أقرب الركشات'}</h2><span class="small muted row gap4">${icon('electric_rickshaw', '', 'font-size:16px')}${num(drivers.length)} متاحة · أقرب واحدة ${num(etaMin(drivers[0].distance_m))} د</span></div>`
          : `<div class="row gap8 card" style="background:var(--yellow-soft)">${icon('info', '', 'color:#7A5A00')}<span class="small">ما في ركشات متاحة قريبة هسع — ممكن ترسل طلبك وأول سواق يتاح بيشوفه.</span></div>`;
        const list = drivers.slice(0, 3).map((d, i) => `<div class="driver-item ${i === 0 ? 'sel' : ''}">
            <span class="rk ${i === 0 ? 'y' : ''}">${icon('electric_rickshaw', 'f', 'font-size:26px')}</span>
            <span class="col grow gap4"><b style="font-size:15px">${esc(d.full_name || 'سواق')}</b>
              <span class="small muted row gap4">${icon('star', 'f', 'font-size:14px;color:var(--star)')}${num(d.rating_avg || 5)} · ${num(etaMin(d.distance_m))} د · ${distStr(d.distance_m)}</span></span>
            ${d.plate_number ? `<span class="plate"><span>السودان</span><span>${esc(d.plate_number)}</span></span>` : ''}</div>`).join('');
        if (!dest) { b.innerHTML = near + (list ? `<div class="col gap8">${list}</div><p class="small muted" style="margin:0;text-align:center">اكتب وجهتك عشان تشوف السعر وتطلب</p>` : ''); return; }
        const joinCards = openShared.map((o, i) => {
          const used = cap() - o.seats_left, est = Math.round(o.price * (1 + pct() * o.groups) / (used + 1) / 100) * 100;
          return `<div class="card col gap8" style="border:2px solid var(--yellow);padding:12px">
            <div class="row gap8">${icon('group', 'f', 'color:#7A5A00')}<b class="grow">طرحة ماشية لـ ${esc(o.dropoff_address || 'نفس الاتجاه')}</b><span class="pill yellow">باقي ${num(o.seats_left)}</span></div>
            <span class="small muted">${o.driver_name ? 'السواق ' + esc(o.driver_name) + ' · ' : ''}نقطة التجمع على بعد ${distStr(o.pickup_away_m)}</span>
            <div class="row" style="justify-content:space-between"><span class="small">نصيبك حوالي <b style="font-size:17px">${money(est)}</b> <span class="muted">بدل ${money(price)}</span></span>
              <button class="btn sm yellow" data-join="${i}" style="width:auto;padding:0 18px">انضم</button></div></div>`;
        }).join('');
        const shareEst = Math.round(price * (1 + pct()) / (seats + 1) * seats / 100) * 100;
        b.innerHTML = `${near}
          ${joinCards ? `<b style="font-size:15px">طرحات ماشية لنفس الاتجاه</b>${joinCards}<div class="row gap8 small muted" style="justify-content:center">— أو اطلب ركشة —</div>` : ''}
          <div class="card col gap8" style="background:${shared ? 'var(--yellow-soft)' : '#F4F6F5'};padding:12px">
            <label class="row gap8" style="cursor:pointer">${icon('group', shared ? 'f' : '', 'color:#7A5A00')}<span class="col grow"><b style="font-size:15px">طرحة — شارك الركشة</b><span class="small muted">ركاب تانيين ماشين نفس الاتجاه بينضموا وتقسموا المبلغ</span></span>
              <input type="checkbox" id="shareTg" ${shared ? 'checked' : ''} style="width:24px;height:24px;accent-color:#0F1A14"></label>
            ${shared ? `<div class="row" style="justify-content:space-between"><span class="small">إنتو كم شخص؟</span>
              <div class="stepper"><button id="sMinus" aria-label="أقل">${icon('remove')}</button><b style="min-width:30px;text-align:center">${num(seats)}</b><button id="sPlus" aria-label="أكتر">${icon('add')}</button></div></div>
              <span class="small">لو انضم ليكم راكب واحد بس، نصيبكم بينزل لحوالي <b>${money(shareEst)}</b></span>` : ''}
          </div>
          <div class="card row" style="background:#F4F6F5;justify-content:space-between">
            <div class="col"><span class="small muted">${num(km.toFixed(1))} كم بالشوارع · حوالي ${num(routeMin)} دقيقة</span><span class="small muted">السواقين ممكن يقترحوا سعر تاني</span></div>
            <div class="stepper"><button id="minus" aria-label="نقّص السعر">${icon('remove')}</button>
              <b class="price" id="priceV" style="min-width:76px;text-align:center">${money(price)}</b>
              <button id="plus" aria-label="زيد السعر">${icon('add')}</button></div>
          </div>
          <div class="row gap8">
            <span class="btn ghost" style="width:96px;font-size:14px">${icon('payments', '', 'color:var(--green)')}كاش</span>
            <button class="btn" id="reqBtn" style="justify-content:space-between"><span>${shared ? 'اطلب طرحة' : 'اطلب ركشة'}</span><span class="row gap4" style="color:var(--yellow)">${money(price)}${icon('arrow_back')}</span></button>
          </div>`;
        const step = Math.max(100, Math.round(suggestPrice(km) * 0.05 / 100) * 100);
        $('#shareTg').onchange = (e) => { shared = e.target.checked; renderBottom(); };
        $('#sMinus') && ($('#sMinus').onclick = () => { seats = Math.max(1, seats - 1); renderBottom(); });
        $('#sPlus') && ($('#sPlus').onclick = () => { seats = Math.min(cap() - 1, seats + 1); renderBottom(); });
        $$('[data-join]').forEach(btn => btn.onclick = async () => {
          const o = openShared[+btn.dataset.join];
          btn.disabled = true;
          const ok = await safe(() => rpc('join_shared_trip', { p_trip: o.id, p_seats: 1, plat: pickup[0], plng: pickup[1], paddr: pickupAddr, dlat: dest.lat, dlng: dest.lng, daddr: dest.name }), 'انضميت للطرحة!');
          if (ok !== undefined) { haptic(); go(o.status === 'requested' ? 'waiting' : 'tracking', { id: o.id }, { root: true }); } else btn.disabled = false;
        });
        $('#minus').onclick = () => { price = Math.max(Math.round(suggestPrice(km) * 0.7 / 100) * 100, price - step); renderBottom(); };
        $('#plus').onclick = () => { price += step; renderBottom(); };
        $('#reqBtn').onclick = async (ev) => {
          const btn = ev.currentTarget; btn.disabled = true;
          const trip = await safe(async () => {
            const { data, error } = await sb.from('trips').insert({
              rider_id: S.user.id, pickup: pointWKT(pickup[0], pickup[1]), pickup_address: pickupAddr,
              dropoff: pointWKT(dest.lat, dest.lng), dropoff_address: dest.name,
              distance_km: +km.toFixed(2), offered_price: price
            }).select().single();
            if (error) throw error;
            if (shared) await rpc('make_trip_shared', { p_trip: data.id, p_seats: seats });
            return data;
          });
          if (trip) { haptic(); go('waiting', { id: trip.id }, { root: true }); }
          else btn.disabled = false;
        };
      }
      renderBottom();
    }
  };
};

/* ---------- Rider: Waiting for offers ---------- */
Screens.waiting = ({ id }) => ({
  html: `<div class="screen" style="background:#fff">
    <div class="topbar" style="box-shadow:none"><h1></h1></div>
    <div class="scroll pad col gap16" style="align-items:stretch">
      <div class="col gap12" style="align-items:center;padding:24px 0 8px;text-align:center">
        <div class="pulse">${icon('electric_rickshaw', 'f', 'font-size:42px')}</div>
        <h2 class="h1" style="font-size:22px;margin-top:20px">بنرسل طلبك للركشات القريبة</h2>
        <p class="muted" style="margin:0" id="tripInfo">…</p>
      </div>
      <div id="wShares"></div>
      <div class="row" style="justify-content:space-between" id="offHead"><b>عروض السواقين</b><span class="small muted" id="offCount"></span></div>
      <div id="offers" class="col gap8"><div class="empty" style="padding:20px">${icon('hourglass_top')}<span>العروض بتظهر هنا أول ما سواق يرد</span></div></div>
    </div>
    <div class="pad" style="padding-bottom:calc(var(--safe-bot) + 16px)"><button class="btn danger" id="cancel">${icon('close')}إلغاء الطلب</button></div>
  </div>`,
  async mount() {
    const trip = await safe(() => getTrip(id));
    if (!trip) return home();
    if (trip.status !== 'requested') return routeToActive();
    const owner = trip.rider_id === S.user.id;
    $('#tripInfo').textContent = `${trip.dropoff_address || 'وجهتك'} · ${owner ? 'عرضك ' + money(trip.offered_price) : 'طرحة'}`;
    const paintShares = async () => { if (!trip.is_shared) return; const sh = await loadShares(id); if ($('#wShares')) $('#wShares').innerHTML = sharesHtml(sh); };
    paintShares();
    if (trip.is_shared) channel('wsh').on('postgres_changes', { event: '*', schema: 'public', table: 'trip_passengers', filter: `trip_id=eq.${id}` }, () => { haptic(); paintShares(); }).subscribe();
    if (!owner) {
      $('#offHead').remove();
      $('#offers').innerHTML = `<div class="card row gap8" style="background:#F4F6F5">${icon('hourglass_top', '', 'color:var(--ink3)')}<span class="small">منتظرين صاحب الطلب يختار سواق. أول ما سواق يقبل بنوريك مكانه.</span></div>`;
      $('#cancel').innerHTML = `${icon('logout')}انسحاب من الطرحة`;
      $('#cancel').onclick = async () => {
        if (!(await confirmBox('تنسحب من الطرحة؟', 'مكانك بيتفتح لراكب تاني.', 'انسحاب', true))) return;
        const ok = await safe(() => rpc('leave_shared_trip', { p_trip: id }));
        if (ok !== undefined) home();
      };
      channel('wj').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trips', filter: `id=eq.${id}` }, (p) => {
        if (p.new.status === 'accepted') { haptic(); toast('سواق قبل الطرحة!', 'success'); go('tracking', { id }, { root: true }); }
        if (p.new.status === 'cancelled') { toast('صاحب الطلب لغى الطرحة', 'error'); home(); }
      }).subscribe();
      return;
    }
    const cache = {};
    const loadOffers = async () => {
      const { data } = await sb.from('trip_offers').select('*').eq('trip_id', id).eq('status', 'pending').order('price');
      const offers = data || [];
      for (const o of offers) if (!cache[o.driver_id]) cache[o.driver_id] = await getDriverPublic(o.driver_id);
      $('#offCount').textContent = offers.length ? `${num(offers.length)} عرض` : '';
      if (!offers.length) return;
      $('#offers').innerHTML = offers.map(o => {
        const d = cache[o.driver_id] || {};
        const away = d._loc && trip._pickup ? haversineKm(d._loc, trip._pickup) * 1000 : null;
        return `<div class="driver-item" style="flex-wrap:wrap">
          <div class="rk y">${icon('electric_rickshaw', 'f', 'font-size:26px')}</div>
          <div class="col grow gap4"><b style="font-size:15px">${esc(d.full_name || 'سواق')}</b>
            <span class="small muted row gap4">${icon('star', 'f', 'font-size:14px;color:var(--star)')}${num(d.rating_avg || 5)}${away != null ? ` · ${num(etaMin(away))} د · ${distStr(away)}` : ''}${d.plate_number ? ' · ' + esc(d.plate_number) : ''}</span></div>
          <div class="col" style="align-items:flex-start"><span class="price">${money(o.price)}</span>${o.price < trip.offered_price ? '<span class="pill green">أرخص</span>' : o.price > trip.offered_price ? '<span class="pill yellow">أعلى من عرضك</span>' : ''}</div>
          <button class="btn sm" data-acc="${o.id}" style="margin-top:6px">قبول العرض</button></div>`;
      }).join('');
      $$('[data-acc]').forEach(b => b.onclick = async () => {
        b.disabled = true;
        const ok = await safe(() => rpc('accept_offer', { p_offer: b.dataset.acc }));
        if (ok !== undefined) { haptic(); go('tracking', { id }, { root: true }); } else b.disabled = false;
      });
    };
    loadOffers();
    channel('offers').on('postgres_changes', { event: '*', schema: 'public', table: 'trip_offers', filter: `trip_id=eq.${id}` }, loadOffers)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trips', filter: `id=eq.${id}` }, (p) => {
        if (p.new.status === 'accepted') { haptic(); toast('سواق قبل طلبك!', 'success'); go('tracking', { id }, { root: true }); }
        if (p.new.status === 'cancelled') { toast('الطلب اتلغى'); home(); }
      }).subscribe();
    every(15000, loadOffers);
    const expire = setTimeout(async () => {
      toast('ما في سواق رد خلال ١٥ دقيقة — جرّب ترفع السعر شوية', 'error');
      await rpc('set_trip_status', { p_trip: id, p_status: 'cancelled', p_reason: 'expired' }).catch(() => {});
      home();
    }, Math.max(1000, 15 * 60000 - (Date.now() - new Date(trip.created_at))));
    onLeave(() => clearTimeout(expire));
    $('#cancel').onclick = async () => {
      if (!(await confirmBox('تلغي الطلب؟', 'السواقين ما حيشوفوا طلبك تاني.', 'إلغاء الطلب', true))) return;
      const ok = await safe(() => rpc('set_trip_status', { p_trip: id, p_status: 'cancelled', p_reason: 'rider_cancel' }));
      if (ok !== undefined) home();
    };
  }
});

/* ---------- الطرحة: قائمة الركاب ونصيب كل واحد ---------- */
async function loadShares(tripId) {
  const { data } = await sb.rpc('trip_shares', { p_trip: tripId });
  return data || [];
}
function sharesHtml(shares, opts = {}) {
  if (!shares.length) return '';
  const me = shares.find(x => x.rider_id === S.user.id);
  const seats = shares.reduce((a, x) => a + x.seats, 0);
  return `<div class="card col gap8" style="background:var(--yellow-soft)">
    <div class="row gap8">${icon('group', 'f', 'color:#7A5A00')}<b class="grow">طرحة · ${num(seats)} ${seats > 2 ? 'ركاب' : 'راكب'}</b>
      ${me && !opts.driver ? `<span class="small">نصيبك <b style="font-size:16px">${money(me.share)}</b></span>` : `<span class="small">الإجمالي <b style="font-size:16px">${money(shares[0].total)}</b></span>`}</div>
    ${shares.map(x => `<div class="row gap8 small" style="border-top:1px dashed rgba(122,90,0,.25);padding-top:6px">
      <span class="avatar" style="width:30px;height:30px;font-size:13px;border-radius:10px">${initial(x.full_name)}</span>
      <span class="col grow" style="min-width:0"><b>${esc(x.rider_id === S.user.id ? 'إنت' : x.full_name || 'راكب')}${x.seats > 1 ? ` (+${num(x.seats - 1)})` : ''}</b>
        ${opts.driver ? `<span class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${icon('trip_origin', '', 'font-size:12px;color:var(--blue)')} ${esc(x.pickup_address || '')} ← ${esc(x.dropoff_address || '')}</span>` : ''}</span>
      ${opts.driver && x.phone ? `<a class="icon-btn" href="tel:${esc(x.phone)}" aria-label="اتصال" style="width:34px;height:34px;background:#fff">${icon('call', '', 'font-size:18px')}</a>` : ''}
      <b>${money(x.share)}</b></div>`).join('')}
    <span class="small muted">كل مجموعة إضافية بتزيد الإجمالي ${num(S.settings?.shared_extra_pct ?? 25)}٪ للسواق، والمبلغ بيتقسم على عدد الركاب</span>
  </div>`;
}

/* ---------- Shared: unread chat counter ---------- */
async function unreadCount(tripId) {
  const { count } = await sb.from('messages').select('id', { count: 'exact', head: true })
    .eq('trip_id', tripId).neq('sender_id', S.user.id).is('read_at', null);
  return count || 0;
}

/* ---------- Rider: Tracking ---------- */
Screens.tracking = ({ id }) => {
  let map, drvMk, trip, drv;
  return {
    html: `<div class="screen">
      <div id="map" class="map"></div>
      <div class="map-top">
        <div class="loc-box" style="background:var(--ink);color:#fff;justify-content:space-between">
          <span class="row gap8" style="font-size:14px">${icon('near_me', '', 'font-size:20px;color:var(--yellow)')}<span id="stTxt">…</span></span>
          <b id="eta" style="color:var(--yellow);font-size:17px"></b></div>
      </div>
      <div class="sheet" id="sheet"><div class="grab"></div><div class="col" style="align-items:center;padding:30px"><div class="spinner"></div></div></div>
    </div>`,
    async mount() {
      trip = await safe(() => getTrip(id));
      if (!trip) return home();
      if (trip.status === 'requested') return go('waiting', { id }, { root: true });
      if (trip.status === 'completed') return go('rating', { id }, { root: true });
      if (trip.status === 'cancelled') { toast('المشوار اتلغى'); return home(); }
      drv = await getDriverPublic(trip.driver_id);
      if (!$('#stTxt')) return;
      map = makeMap($('#map'), trip._pickup, 15);
      onLeave(() => { map._dead = true; try { map.stop(); map.off(); map.remove(); } catch (_) {} });
      L.marker(trip._pickup, { icon: meIcon() }).addTo(map);
      L.marker(trip._dropoff, { icon: destIcon() }).addTo(map);
      const rf = routeFollower(map);
      const updDriver = async (loc) => {
        if (!loc || map._dead) return;
        drv._loc = loc;
        if (!drvMk) drvMk = L.marker(loc, { icon: rkIcon(), zIndexOffset: 1000 }).addTo(map); else animateMarker(drvMk, loc);
        const target = trip.status === 'in_progress' ? trip._dropoff : trip._pickup;
        const r = await rf.update(loc, target);
        if (r && $('#eta')) $('#eta').textContent = trip.status === 'arrived' ? '' : `${num(r.min)} د · ${num(r.km.toFixed(1))} كم`;
      };
      updDriver(drv._loc);
      map.fitBounds(L.latLngBounds([trip._pickup, trip._dropoff].concat(drv._loc ? [drv._loc] : [])).pad(0.35), { paddingBottomRight: [0, 300] });

      let sh = [];
      const render = async () => {
        if (!$('#stTxt')) return;
        $('#stTxt').textContent = STATUS_AR[trip.status];
        const idx = STEP_IDX[trip.status] || 1;
        const unread = await unreadCount(id);
        if (!$('#sheet')) return;
        $('#sheet').innerHTML = `<div class="grab"></div>
          <div class="col gap8"><div class="progress">${[1, 2, 3, 4].map(i => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('')}</div>
            <div class="row small muted" style="justify-content:space-between"><span>تم القبول</span><span>في الطريق</span><span>وصل</span><span>المشوار</span></div></div>
          <div class="row gap12">
            <div style="position:relative"><div class="avatar" style="width:58px;height:58px;border-radius:18px;font-size:22px">${drv.avatar_url ? `<img src="${esc(drv.avatar_url)}" alt="">` : initial(drv.full_name)}</div>
              <span style="position:absolute;bottom:-6px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;border-radius:999px;padding:1px 6px;font-size:11px;display:flex;align-items:center;gap:2px">${icon('star', 'f', 'font-size:12px;color:var(--yellow)')}${num(drv.rating_avg || 5)}</span></div>
            <div class="col grow gap4"><b style="font-size:17px">${esc(drv.full_name || 'السواق')}</b><span class="small muted">${esc(drv.vehicle_color ? 'ركشة ' + drv.vehicle_color : 'ركشة')} · ${num(drv.rating_count || 0)} تقييم</span></div>
            ${drv.plate_number ? `<div class="plate"><span>السودان</span><span>${esc(drv.plate_number)}</span></div>` : ''}
          </div>
          <div class="actions3">
            <button class="act dark" id="chatBtn">${icon('chat')}دردشة${unread ? `<span class="badge">${num(unread)}</span>` : ''}</button>
            <a class="act" href="tel:${esc(drv.phone || '')}">${icon('call')}اتصال</a>
            <button class="act" id="shareBtn">${icon('shield_person')}شارك الرحلة</button>
          </div>
          ${trip.status === 'in_progress' ? meterHtml(trip, +trip.traveled_km || 0) : ''}
          ${trip.is_shared ? sharesHtml(sh = await loadShares(id)) : ''}
          <div class="row gap8 card" style="background:#F4F6F5">${icon('flag', '', 'color:var(--ink3)')}<span class="grow" style="font-size:14px">${esc(trip.dropoff_address || 'الوجهة')}</span><b class="row gap4">${icon('payments', '', 'font-size:18px;color:var(--green)')}${money((trip.is_shared && (sh.find(x => x.rider_id === S.user.id) || {}).share) || trip.final_price || trip.offered_price)}</b></div>
          <div class="row gap8">${trip.status !== 'in_progress' ? `<button class="btn danger" id="cancelBtn">${icon(trip.rider_id === S.user.id ? 'close' : 'logout')}${trip.rider_id === S.user.id ? 'إلغاء المشوار' : 'انسحاب'}</button>` : ''}
            <button class="btn danger" id="reportBtn" style="color:var(--ink3)">${icon('flag')}إبلاغ</button></div>`;
        $('#chatBtn').onclick = () => go('chat', { id });
        $('#reportBtn').onclick = () => openReport({ tripId: id, reportedId: trip.driver_id, reportedName: drv.full_name });
        if (trip.rider_id !== S.user.id && $('#cancelBtn')) $('#cancelBtn').onclick = async () => {
          if (!(await confirmBox('تنسحب من الطرحة؟', 'السواق والركاب التانيين بيكملوا من غيرك.', 'انسحاب', true))) return;
          const ok = await safe(() => rpc('leave_shared_trip', { p_trip: id })); if (ok !== undefined) home();
        };
        $('#shareBtn').onclick = () => shareTrip(trip, drv);
        trip.rider_id === S.user.id && $('#cancelBtn') && ($('#cancelBtn').onclick = async () => {
          if (!(await confirmBox('تلغي المشوار؟', 'السواق جاي في الطريق ليك. لو لغيت كتير تقييمك ممكن يتأثر.', 'إلغاء', true))) return;
          const ok = await safe(() => rpc('set_trip_status', { p_trip: id, p_status: 'cancelled', p_reason: 'rider_cancel' }));
          if (ok !== undefined) home();
        });
      };
      render();
      channel('trk').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trips', filter: `id=eq.${id}` }, (p) => {
        const prev = trip.status;
        Object.assign(trip, p.new); trip._pickup = parsePoint(p.new.pickup) || trip._pickup; trip._dropoff = parsePoint(p.new.dropoff) || trip._dropoff;
        if (trip.status === 'completed') { haptic(); return go('rating', { id }, { root: true }); }
        if (trip.status === 'cancelled') { toast('السواق لغى المشوار — ممكن تطلب تاني', 'error'); return home(); }
        if (prev === trip.status && trip.status === 'in_progress' && $('#mKm')) {
          const k = +trip.traveled_km || 0; $('#mKm').textContent = num(k.toFixed(2)); $('#mFare').textContent = money(fareFor(k)); return;
        }
        if (prev !== trip.status) { haptic(); if (trip.status === 'arrived') toast('الركشة وصلت! السواق منتظرك', 'success'); }
        render(); updDriver(drv._loc);
      }).on('postgres_changes', { event: '*', schema: 'public', table: 'trip_passengers', filter: `trip_id=eq.${id}` }, () => { if (trip.is_shared) render(); })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'drivers', filter: `id=eq.${trip.driver_id}` }, (p) => {
        updDriver(parsePoint(p.new.location));
      }).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `trip_id=eq.${id}` }, (p) => {
        if (p.new.sender_id !== S.user.id) { haptic(); toast('رسالة جديدة من السواق'); render(); }
      }).subscribe();
      // احتياطي لو الـ realtime اتقطع
      every(12000, async () => {
        const d = await getDriverPublic(trip.driver_id); updDriver(d._loc);
        const t = await getTrip(id).catch(() => null);
        if (t && t.status !== trip.status) { Object.assign(trip, t); if (['completed', 'cancelled'].includes(t.status)) return routeAfter(t); render(); }
      });
    }
  };
};
function routeAfter(t) { if (t.status === 'completed') go('rating', { id: t.id }, { root: true }); else home(); }

async function shareTrip(trip, drv) {
  const loc = drv._loc ? `https://maps.google.com/?q=${drv._loc[0]},${drv._loc[1]}` : '';
  const text = `أنا راكب ركشة مع ${drv.full_name || 'سواق'}${drv.plate_number ? ' — لوحة ' + drv.plate_number : ''}، ماشي ${trip.dropoff_address || ''}. موقع الركشة: ${loc}`;
  try {
    if (P.Share) await P.Share.share({ title: 'رحلتي على ركشتي', text });
    else if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('اتنسخت تفاصيل الرحلة', 'success'); }
  } catch (_) {}
}

/* ---------- Shared: Chat ---------- */
Screens.chat = ({ id }) => {
  let trip, other, msgs = [];
  const mine = (m) => m.sender_id === S.user.id;
  const quick = () => S.mode === 'driver'
    ? ['أنا جاي في الطريق', 'وصلت، إنت وين؟', 'دقيقتين وأكون عندك', 'تمام']
    : ['أنا قدام الباب', 'إنت وين هسع؟', 'اتأخرت شوية', 'تمام، منتظرك'];
  return {
    html: `<div class="screen" style="background:var(--bg)">
      <div class="topbar">
        <button class="icon-btn" data-back aria-label="رجوع">${icon('arrow_forward')}</button>
        <div class="avatar" id="cAv" style="width:42px;height:42px">؟</div>
        <div class="col grow"><b id="cName" style="font-size:16px">…</b><span class="small muted" id="cSub"></span></div>
        <a class="icon-btn dark" id="cCall" aria-label="اتصال">${icon('call', 'f', 'font-size:20px')}</a>
      </div>
      <div class="scroll pad col gap8" id="msgs">
        <div class="row gap4 small muted" style="align-self:center;background:#E5E9E7;padding:4px 10px;border-radius:999px">${icon('lock', '', 'font-size:14px')}الرسائل خاصة بينك وبين ${S.mode === 'driver' ? 'الراكب' : 'السواق'} في المشوار ده</div>
      </div>
      <div class="hscroll" id="quick">${quick().map(q => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <form class="composer" id="cForm">
        <button type="button" class="round" id="sendLoc" aria-label="إرسال موقعي">${icon('share_location')}</button>
        <label for="cIn" class="sr">اكتب رسالة</label>
        <input id="cIn" placeholder="اكتب رسالة…" autocomplete="off" enterkeyhint="send">
        <button class="round y" aria-label="إرسال">${icon('send', 'f', 'transform:scaleX(-1)')}</button>
      </form></div>`,
    async mount(root) {
      bindBack(root);
      let ready, readyP = new Promise(r => ready = r), send = async () => {};
      $('#cForm').onsubmit = async (e) => { e.preventDefault(); const v = $('#cIn').value.trim(); $('#cIn').value = ''; await readyP; send(v); };
      $$('[data-q]').forEach(b => b.onclick = async () => { await readyP; send(b.dataset.q); });
      $('#sendLoc').onclick = async () => { const p = await getPos(); await readyP; send('ده موقعي، تعال عليه مباشرة', p); };
      trip = await safe(() => getTrip(id));
      if (!trip) return back();
      const otherId = trip.driver_id === S.user.id ? trip.rider_id : trip.driver_id;
      other = otherId === trip.driver_id ? await getDriverPublic(otherId) : await getProfile(otherId);
      $('#cName').textContent = other.full_name || '';
      $('#cAv').innerHTML = other.avatar_url ? `<img src="${esc(other.avatar_url)}" alt="">` : initial(other.full_name);
      $('#cSub').textContent = other.plate_number ? `لوحة ${other.plate_number}` : STATUS_AR[trip.status];
      $('#cCall').href = 'tel:' + (other.phone || '');
      const box = $('#msgs');
      const renderMsg = (m) => {
        const loc = parsePoint(m.location);
        const d = document.createElement('div');
        d.className = 'bubble ' + (mine(m) ? 'me' : 'them');
        d.innerHTML = `${loc ? `<a href="https://maps.google.com/?q=${loc[0]},${loc[1]}" style="color:inherit;text-decoration:none;display:flex;align-items:center;gap:6px;background:rgba(127,127,127,.15);border-radius:12px;padding:10px">${icon('location_on', 'f', 'color:var(--yellow)')}<b style="font-size:13px">موقعي — افتحه في الخريطة</b></a>` : ''}
          ${m.body ? `<span>${esc(m.body)}</span>` : ''}
          <span class="t">${timeStr(m.created_at)}${mine(m) ? icon(m.read_at ? 'done_all' : 'done', '', `font-size:14px;color:${m.read_at ? 'var(--yellow)' : 'inherit'}`) : ''}</span>`;
        d.dataset.id = m.id;
        box.appendChild(d);
      };
      const scrollEnd = () => { box.scrollTop = box.scrollHeight; };
      const markRead = () => sb.from('messages').update({ read_at: new Date().toISOString() })
        .eq('trip_id', id).neq('sender_id', S.user.id).is('read_at', null).then(() => {});
      const { data } = await sb.from('messages').select('*').eq('trip_id', id).order('created_at');
      msgs = data || [];
      msgs.forEach(renderMsg); scrollEnd(); markRead();
      channel('chat').on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `trip_id=eq.${id}` }, (p) => {
        if (p.eventType === 'INSERT') {
          if ($(`[data-id="${p.new.id}"]`, box)) return;
          renderMsg(p.new); scrollEnd();
          if (!mine(p.new)) { haptic(); markRead(); }
        } else if (p.eventType === 'UPDATE') {
          const el = $(`[data-id="${p.new.id}"]`, box);
          if (el && mine(p.new) && p.new.read_at) { const t = $('.t .ms', el); if (t) { t.textContent = 'done_all'; t.style.color = 'var(--yellow)'; } }
        }
      }).subscribe();
      send = async (body, loc) => {
        if (!body && !loc) return;
        const row = { trip_id: id, sender_id: S.user.id, body: body || null, location: loc ? pointWKT(loc[0], loc[1]) : null };
        const { data: m, error } = await sb.from('messages').insert(row).select().single();
        if (error) return toast(errMsg(error), 'error');
        if (!$(`[data-id="${m.id}"]`, box)) { renderMsg(m); scrollEnd(); }
      };
      ready();
    }
  };
};

/* ---------- Rider: Rating ---------- */
Screens.rating = ({ id }) => {
  let stars = 5; const tags = new Set();
  const TAGS = [['shield', 'سواقة آمنة'], ['schedule', 'جا في الزمن'], ['mood', 'ونيس'], ['cleaning_services', 'ركشة نظيفة'], ['route', 'عارف الطريق']];
  const LABELS = ['', 'سيء', 'مقبول', 'كويس', 'كويس جداً', 'ممتاز'];
  return {
    html: `<div class="screen scroll" style="background:var(--bg)"><div class="pad col gap12" style="padding-top:calc(var(--safe-top) + 24px)">
      <div class="col gap8" style="align-items:center;text-align:center">
        <div style="width:72px;height:72px;border-radius:50%;background:var(--green);display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 10px rgba(18,183,106,.14)">${icon('check', '', 'font-size:40px;color:#fff')}</div>
        <h1 class="h1" style="margin-top:12px" id="rTitle">وصلت بالسلامة!</h1><p class="muted" style="margin:0" id="rSub"></p></div>
      <div class="card" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));text-align:center" id="rStats"></div>
      <div class="card col gap12" style="align-items:center;border-radius:24px;padding:20px 16px">
        <div class="row gap8"><div class="avatar" id="rAv">؟</div><div class="col"><span class="small muted">كيف كان مشوارك مع</span><b style="font-size:17px" id="rName">…</b></div></div>
        <div class="stars" role="radiogroup" aria-label="التقييم">${[1, 2, 3, 4, 5].map(i => `<button type="button" role="radio" data-s="${i}" aria-label="${num(i)} نجوم">${icon('star')}</button>`).join('')}</div>
        <b id="sLabel"></b>
        <div class="row gap8" style="flex-wrap:wrap;justify-content:center">${TAGS.map(([ic, t]) => `<button type="button" class="chip" data-t="${t}" aria-pressed="false">${icon(ic, '', 'font-size:16px')}${t}</button>`).join('')}</div>
        <label for="note" class="sr">ملاحظة</label><input class="input" id="note" placeholder="أضف ملاحظة (اختياري)" style="height:48px">
      </div>
      <div class="row gap8"><button class="btn ghost" id="skip" style="width:96px">تخطي</button><button class="btn" id="send" disabled>أرسل التقييم</button></div>
      <button class="btn danger" id="rateReport" style="color:var(--ink3)">${icon('flag')}حصلت مشكلة؟ بلّغ</button>
    </div></div>`,
    async mount() {
      const trip = await safe(() => getTrip(id));
      if (!trip) return home();
      const iAmRider = trip.driver_id !== S.user.id;
      const otherId = iAmRider ? trip.driver_id : trip.rider_id;
      const o = await getProfile(otherId);
      if (!iAmRider) { $('#rTitle').textContent = 'المشوار اكتمل'; }
      $('#rName').textContent = (o.full_name || '') + '؟';
      $('#rAv').innerHTML = initial(o.full_name);
      $('#rSub').textContent = `${trip.dropoff_address || ''} · ${trip.completed_at ? timeStr(trip.completed_at) : ''}`;
      let pay = trip.final_price;
      if (trip.is_shared) { const sh = await loadShares(id); const me = sh.find(x => x.rider_id === S.user.id); pay = iAmRider && me ? me.share : (sh[0]?.total || pay); }
      const mins = trip.completed_at && trip.accepted_at ? Math.round((new Date(trip.completed_at) - new Date(trip.accepted_at)) / 60000) : null;
      $('#rStats').innerHTML = `<div class="col"><span class="small muted">المسافة</span><b>${num((+trip.traveled_km > 0 ? +trip.traveled_km : +trip.distance_km || 0).toFixed(1))} كم</b></div>
        <div class="col" style="border-inline:1px solid var(--line)"><span class="small muted">الزمن</span><b>${mins != null ? num(mins) + ' د' : '—'}</b></div>
        <div class="col"><span class="small muted">${iAmRider ? (trip.is_shared ? 'نصيبك كاش' : 'ادفع كاش') : 'استلم كاش'}</span><b>${money(pay)}</b></div>`;
      const paint = () => {
        $$('[data-s]').forEach(b => { const on = +b.dataset.s <= stars; $('.ms', b).classList.toggle('on', on); b.setAttribute('aria-checked', +b.dataset.s === stars); });
        $('#sLabel').textContent = LABELS[stars];
      };
      paint();
      $$('[data-s]').forEach(b => b.onclick = () => { stars = +b.dataset.s; haptic(); paint(); });
      $$('[data-t]').forEach(b => b.onclick = () => { const t = b.dataset.t; tags.has(t) ? tags.delete(t) : tags.add(t); b.classList.toggle('on'); b.setAttribute('aria-pressed', tags.has(t)); });
      $('#skip').onclick = home;
      $('#rateReport').onclick = () => openReport({ tripId: id, reportedId: otherId, reportedName: o.full_name });
      const pa = () => { if (stars <= 2) $('#rateReport').style.color = 'var(--red)'; };
      $$('[data-s]').forEach(b => b.addEventListener('click', pa));
      $('#send').disabled = false;
      $('#send').onclick = async () => {
        const ok = await safe(async () => {
          const { error } = await sb.from('ratings').insert({ trip_id: id, rater_id: S.user.id, ratee_id: otherId, stars, tags: [...tags], note: $('#note').value.trim() || null });
          if (error && !String(error.message).includes('duplicate')) throw error;
          return true;
        }, 'شكراً على تقييمك!');
        if (ok) home();
      };
    }
  };
};

/* ---------- History ---------- */
Screens.history = ({ filter = 'all' } = {}) => ({
  html: `<div class="screen" style="background:var(--bg)">
    <div class="pad row" style="padding-top:calc(var(--safe-top) + 14px);justify-content:space-between"><h1 class="h1">مشاويري</h1></div>
    <div style="padding:0 16px" id="hStats"></div>
    <div style="padding:14px 16px 0"><div class="seg" role="tablist">
      ${[['all', 'الكل'], ['completed', 'مكتملة'], ['cancelled', 'ملغية']].map(([k, l]) => `<button role="tab" data-f="${k}" class="${filter === k ? 'on' : ''}" aria-selected="${filter === k}">${l}</button>`).join('')}
    </div></div>
    <div class="scroll pad col gap8" id="hList"><div class="col" style="align-items:center;padding:30px"><div class="spinner"></div></div></div>
  </div>${nav('history')}`,
  async mount(root) {
    bindNav(root);
    $$('[data-f]').forEach(b => b.onclick = () => go('history', { filter: b.dataset.f }, { replace: true }));
    const col = S.mode === 'driver' ? 'driver_id' : 'rider_id';
    let q = sb.from('trips').select('*').order('created_at', { ascending: false }).limit(60);
    if (S.mode === 'driver') q = q.eq(col, S.user.id);
    else {
      const { data: jp } = await sb.from('trip_passengers').select('trip_id').eq('rider_id', S.user.id).eq('status', 'joined').limit(60);
      const ids = (jp || []).map(x => x.trip_id);
      q = ids.length ? q.or(`rider_id.eq.${S.user.id},id.in.(${ids.join(',')})`) : q.eq('rider_id', S.user.id);
    }
    q = filter === 'all' ? q.in('status', ['completed', 'cancelled']) : q.eq('status', filter);
    const { data } = await q;
    const trips = data || [];
    const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
    const mTrips = trips.filter(t => t.status === 'completed' && new Date(t.created_at) >= month);
    const sum = mTrips.reduce((a, t) => a + (t.final_price || 0), 0);
    const kms = mTrips.reduce((a, t) => a + (+t.distance_km || 0), 0);
    $('#hStats').innerHTML = `<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">
      <div class="stat" style="background:var(--ink);color:#fff">${icon('electric_rickshaw', '', 'font-size:20px;color:var(--yellow)')}<b>${num(mTrips.length)}</b><span class="small" style="color:#C2CCC6">مشوار الشهر ده</span></div>
      <div class="stat">${icon('payments', '', 'font-size:20px;color:var(--green)')}<b>${num(sum)}</b><span class="small muted">جنيه ${S.mode === 'driver' ? 'دخل' : 'صرفتها'}</span></div>
      <div class="stat">${icon('route', '', 'font-size:20px;color:var(--blue)')}<b>${num(Math.round(kms))} كم</b><span class="small muted">مسافة</span></div></div>`;
    if (!trips.length) { $('#hList').innerHTML = `<div class="empty">${icon('receipt_long')}<b>لسه ما عندك مشاوير</b><span class="small">أول مشوار بيظهر هنا</span></div>`; return; }
    const tmap = {}; trips.forEach(t => tmap[t.id] = t);
    let lastDay = '';
    $('#hList').innerHTML = trips.map(t => {
      const d = dayStr(t.created_at); const head = d !== lastDay ? `<span class="small muted" style="font-weight:600;margin-top:6px">${d}</span>` : ''; lastDay = d;
      const done = t.status === 'completed';
      return `${head}<div class="card col gap12">
        <div class="row gap8"><span class="rk" style="width:40px;height:40px;border-radius:12px;background:var(--yellow-soft)">${icon('electric_rickshaw', 'f', 'font-size:22px')}</span>
          <div class="col grow"><b style="font-size:15px">${esc(t.dropoff_address || 'مشوار')}</b><span class="small muted">${timeStr(t.created_at)} · ${num((+t.distance_km || 0).toFixed(1))} كم</span></div>
          <div class="col gap4" style="align-items:flex-start"><b>${done ? money(t.final_price) : '—'}</b><span class="pill ${done ? 'green' : 'red'}">${done ? 'مكتمل' : 'ملغي'}</span></div></div>
        <div class="row small muted gap4" style="border-top:1px dashed var(--line);padding-top:10px">${icon('trip_origin', '', 'font-size:16px')}<span class="grow">${esc(t.pickup_address || '')}</span>
          ${t.driver_id ? `<button class="chip" data-rp="${t.id}" style="height:32px;font-size:12px">${icon('flag', '', 'font-size:14px')}إبلاغ</button>` : ''}</div></div>`;
    }).join('');
    $$('[data-rp]').forEach(b => b.onclick = () => {
      const t = tmap[b.dataset.rp], other = S.user.id === t.rider_id ? t.driver_id : t.rider_id;
      openReport({ tripId: t.id, reportedId: other });
    });
  }
});

/* ---------- Account ---------- */
Screens.account = () => ({
  html: `<div class="screen" style="background:var(--bg)"><div class="scroll pad col gap12" style="padding-top:calc(var(--safe-top) + 14px)">
    <h1 class="h1">حسابي</h1>
    <div class="card row gap12">
      <label class="avatar" style="width:64px;height:64px;border-radius:20px;font-size:24px;position:relative;cursor:pointer" aria-label="تغيير الصورة">
        ${S.profile?.avatar_url ? `<img src="${esc(S.profile.avatar_url)}" alt="">` : initial(S.profile?.full_name)}
        <input type="file" accept="image/*" id="avIn" class="sr"></label>
      <div class="col grow gap4"><b style="font-size:18px">${esc(S.profile?.full_name || '')}</b>
        <span class="small muted" style="direction:ltr;text-align:right">${esc(S.profile?.phone || '')}</span>
        <span class="small row gap4">${icon('star', 'f', 'font-size:14px;color:var(--star)')}${num(S.profile?.rating_avg || 5)} · ${num(S.profile?.rating_count || 0)} تقييم</span></div>
      <button class="icon-btn" id="editName" aria-label="تعديل الاسم">${icon('edit')}</button>
    </div>
    ${driverCard()}
    ${S.profile?.role === 'admin' ? `<button class="list-btn" id="adminBtn" style="background:var(--yellow-soft)">${icon('admin_panel_settings')}<span class="grow"><b>لوحة الإدارة</b><br><span class="small muted">قبول السواقين، الاشتراكات، الأسعار</span></span>${icon('chevron_left', '', 'color:var(--ink3)')}</button>` : ''}
    <div class="col gap8">
      <button class="list-btn" id="supportBtn">${icon('support_agent')}<span class="grow col"><span>الدعم والمساعدة</span><span class="small muted">دردش مع فريق ركشتي</span></span><span id="supBadge"></span>${icon('chevron_left', '', 'color:var(--ink3)')}</button>
      <button class="list-btn" id="myRpBtn">${icon('flag')}<span class="grow">بلاغاتي</span>${icon('chevron_left', '', 'color:var(--ink3)')}</button>
      <button class="list-btn" id="logout" style="color:var(--red)">${icon('logout')}<span class="grow">تسجيل خروج</span></button>
    </div>
    <p class="small muted" style="text-align:center">ركشتي · الإصدار ١٫٠</p>
  </div></div>${nav('account')}`,
  mount(root) {
    bindNav(root);
    $('#logout').onclick = async () => { Loc.stop(); await sb.auth.signOut(); await storage.removeItem('rk_mode'); S.user = null; go('auth', {}, { root: true }); };
    $('#editName').onclick = () => modal(`<h2 style="margin:0;font-size:20px">تعديل الاسم</h2>
      <input class="input" id="nn" value="${esc(S.profile?.full_name || '')}" aria-label="الاسم"><button class="btn" id="nnOk">حفظ</button>`, (o, close) => {
      $('#nnOk', o).onclick = async () => {
        const v = $('#nn', o).value.trim(); if (v.length < 2) return;
        const ok = await safe(async () => { const { error } = await sb.from('profiles').update({ full_name: v }).eq('id', S.user.id); if (error) throw error; return true; }, 'اتحفظ');
        if (ok) { S.profile.full_name = v; close(); go('account', {}, { replace: true }); }
      };
    });
    $('#avIn').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      await safe(async () => {
        const path = `${S.user.id}/avatar-${Date.now()}.jpg`;
        await uploadImage('avatars', path, f);
        const url = sb.storage.from('avatars').getPublicUrl(path).data.publicUrl;
        const { error } = await sb.from('profiles').update({ avatar_url: url }).eq('id', S.user.id);
        if (error) throw error;
        S.profile.avatar_url = url; go('account', {}, { replace: true });
      }, 'اتغيرت الصورة');
    };
    const sw = $('#modeSw');
    sw && (sw.onclick = async () => {
      const next = S.mode === 'driver' ? 'rider' : 'driver';
      if (next === 'rider' && S.driver?.is_online) await rpc('set_online', { p_online: false }).catch(() => {});
      Loc.stop(); await setMode(next); routeToActive();
    });
    const bd = $('#becomeDriver'); bd && (bd.onclick = () => go('driverSignup'));
    const ad = $('#adminBtn'); ad && (ad.onclick = () => go('admin'));
    $('#supportBtn').onclick = () => go('support');
    $('#myRpBtn').onclick = () => go('myReports');
    sb.from('support_threads').select('unread_user').eq('user_id', S.user.id).maybeSingle().then(({ data }) => {
      if (data && data.unread_user && $('#supBadge')) $('#supBadge').innerHTML = `<span class="pill yellow" style="background:var(--yellow);color:var(--ink)">${num(data.unread_user)}</span>`;
    });
  }
});
function driverCard() {
  const d = S.driver;
  if (!d) return `<button class="card row gap12" id="becomeDriver" style="border:none;text-align:right;width:100%;background:var(--ink);color:#fff">
    <span class="rk y" style="width:48px;height:48px">${icon('badge', '', 'font-size:26px')}</span>
    <span class="col grow gap4"><b style="font-size:16px">عندك ركشة؟</b><span class="small" style="color:#C2CCC6">سجّل كسواق واستلم مشاوير قريبة منك</span></span>${icon('chevron_left', '', 'color:var(--yellow)')}</button>`;
  const st = { pending: ['yellow', 'قيد المراجعة'], approved: ['green', 'مقبول'], rejected: ['red', 'مرفوض'], suspended: ['red', 'موقوف'] }[d.status];
  return `<div class="card col gap12">
    <div class="row gap12"><span class="rk y">${icon('electric_rickshaw', 'f', 'font-size:26px')}</span>
      <div class="col grow"><b>حساب السواق</b><span class="small muted">${esc(d.plate_number || '')} ${d.vehicle_color ? '· ' + esc(d.vehicle_color) : ''}</span></div>
      <span class="pill ${st[0]}">${st[1]}</span></div>
    ${d.status === 'approved'
      ? `<button class="btn ${S.mode === 'driver' ? 'ghost' : 'yellow'}" id="modeSw">${icon('swap_horiz')}${S.mode === 'driver' ? 'التحويل لوضع الراكب' : 'التحويل لوضع السواق'}</button>`
      : d.status === 'pending' ? `<button class="btn ghost sm" id="becomeDriver">${icon('upload_file')}المستندات</button>` : ''}
  </div>`;
}

/* ---------- Driver: Signup ---------- */
Screens.driverSignup = () => {
  const DOCS = [['photo', 'face', 'صورة شخصية', 'وشّك واضح'], ['license', 'id_card', 'رخصة القيادة', 'الوجه الأمامي'], ['vehicle_registration', 'description', 'شهادة بحث الركشة', 'الوجه الأمامي'], ['vehicle_photo', 'electric_rickshaw', 'صورة الركشة واللوحة', 'من الأمام وتظهر اللوحة']];
  return {
    html: `<div class="screen" style="background:var(--bg)">
      <div class="topbar"><button class="icon-btn" data-back aria-label="رجوع">${icon('arrow_forward')}</button><h1>التسجيل كسواق</h1></div>
      <div class="scroll pad col gap12">
        <div class="col gap4"><h2 class="h1" style="font-size:22px">بيانات الركشة</h2><p class="muted" style="margin:0;line-height:1.6">بنراجع بياناتك خلال ٢٤ ساعة وبعدها تبدأ تستلم مشاوير.</p></div>
        <div class="field"><label for="plate">رقم اللوحة</label><input class="input" id="plate" value="${esc(S.driver?.plate_number || '')}" placeholder="مثلاً: خ ٤٥٧"></div>
        <div class="field"><label for="color">لون الركشة</label><input class="input" id="color" value="${esc(S.driver?.vehicle_color || '')}" placeholder="صفراء، خضراء…"></div>
        <div class="field"><label for="bk">رقم حساب بنكك (لاستلام المدفوعات مستقبلاً)</label><input class="input" id="bk" inputmode="numeric" value="${esc(S.driver?.bankak_account || '')}" placeholder="اختياري"></div>
        <b style="margin-top:8px">المستندات</b>
        <div id="docs" class="col gap8"></div>
        <div class="row gap8 card" style="background:#EAF3FE;align-items:flex-start">${icon('lock', 'f', 'font-size:20px;color:#1D6FD1')}<span class="small" style="color:#1B3A5C;line-height:1.6">مستنداتك محفوظة بأمان وما بتظهر للركاب. الراكب بشوف اسمك وصورتك ورقم اللوحة بس.</span></div>
      </div>
      <div class="pad" style="padding-bottom:calc(var(--safe-bot) + 16px)"><button class="btn" id="save">${S.driver ? 'حفظ' : 'إرسال الطلب'}</button></div>
    </div>`,
    async mount(root) {
      bindBack(root);
      let uploaded = {};
      const loadDocs = async () => {
        if (S.driver) { const { data } = await sb.from('driver_documents').select('type,verified').eq('driver_id', S.user.id); (data || []).forEach(d => uploaded[d.type] = d); }
        $('#docs').innerHTML = DOCS.map(([k, ic, t, sub]) => {
          const ok = !!uploaded[k];
          return `<label class="doc ${ok ? 'done' : ''}">
            <span class="rk" style="background:${ok ? 'var(--green-soft)' : 'var(--bg)'}">${icon(ic)}</span>
            <span class="col grow"><b style="font-size:15px">${t}</b><span class="small" style="color:${ok ? 'var(--green-ink)' : 'var(--ink3)'}">${ok ? (uploaded[k].verified ? 'اتراجعت' : 'تم الرفع') : sub}</span></span>
            ${icon(ok ? 'check_circle' : 'add_a_photo', ok ? 'f' : '', `font-size:26px;color:${ok ? 'var(--green)' : 'var(--ink)'}`)}
            <input type="file" accept="image/*" data-doc="${k}" aria-label="${t}"></label>`;
        }).join('');
        $$('[data-doc]').forEach(inp => inp.onchange = async (e) => {
          const f = e.target.files[0]; if (!f) return;
          if (!S.driver) await ensureDriver(); if (!S.driver) return;
          const k = inp.dataset.doc;
          toast('بنرفع الصورة…');
          await safe(async () => {
            const path = `${S.user.id}/${k}.jpg`;
            await uploadImage('driver-docs', path, f);
            const { error } = await sb.from('driver_documents').upsert({ driver_id: S.user.id, type: k, file_path: path, verified: false }, { onConflict: 'driver_id,type' });
            if (error) throw error;
            uploaded[k] = { verified: false }; loadDocs();
          }, 'اترفعت');
        });
      };
      const ensureDriver = async () => {
        const plate = $('#plate').value.trim(), color = $('#color').value.trim();
        if (!plate) { toast('اكتب رقم اللوحة أول', 'error'); return; }
        await safe(async () => {
          const { data, error } = await sb.from('drivers').insert({ id: S.user.id, plate_number: plate, vehicle_color: color, bankak_account: $('#bk').value.trim() || null }).select().single();
          if (error) throw error;
          S.driver = data;
        });
      };
      loadDocs();
      $('#save').onclick = async () => {
        if (!S.driver) { await ensureDriver(); if (!S.driver) return; }
        else {
          const ok = await safe(async () => {
            const { error } = await sb.from('drivers').update({ plate_number: $('#plate').value.trim(), vehicle_color: $('#color').value.trim(), bankak_account: $('#bk').value.trim() || null }).eq('id', S.user.id);
            if (error) throw error; return true;
          });
          if (!ok) return;
        }
        const missing = DOCS.filter(([k]) => !uploaded[k]).length;
        toast(missing ? `اتحفظ — باقي ${num(missing)} مستند` : 'طلبك وصل! بنراجعه ونرد عليك', missing ? '' : 'success');
        if (!missing) go('account', {}, { root: true });
      };
    }
  };
};

/* ---------- Driver: Home (requests) ---------- */
Screens.driverHome = () => {
  let map, meMk, accCircle;
  const reqLayer = L.layerGroup();
  return {
    html: `<div class="screen">
      <div id="map" class="map"></div>
      <div class="map-top" style="justify-content:space-between">
        <div class="loc-box" style="flex:0 1 auto;height:auto;padding:8px 14px;flex-direction:column;align-items:flex-start;gap:0">
          <span class="small muted" id="todayLbl">دخل اليوم</span><b style="font-size:18px" id="today">…</b></div>
        <button id="onlineBtn" aria-pressed="false" style="display:flex;align-items:center;gap:10px;border:none;border-radius:999px;padding:6px 6px 6px 16px;font-size:14px;font-weight:600;color:#fff;background:#5B6660;box-shadow:0 4px 16px rgba(15,26,20,.18)"><span id="onLbl">غير متاح</span><span style="width:36px;height:36px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center">${icon('power_settings_new', '', 'font-size:20px;color:#5B6660')}</span></button>
      </div>
      <button class="icon-btn float" id="dRecenter" aria-label="موقعي" style="position:absolute;right:16px;bottom:calc(36% + 16px);z-index:500;border-radius:50%;width:48px;height:48px">${icon('my_location')}</button>
      <div class="sheet" id="dSheet" style="max-height:36%"><div class="grab"></div>
        <div class="row" style="justify-content:space-between"><h2 style="margin:0;font-size:18px">طلبات قريبة</h2><span class="small muted row gap4" id="reqCount"></span></div>
        <div id="reqs" class="col gap8"></div></div>
      </div>${nav('driverHome')}`,
    async mount(root) {
      bindNav(root);
      if (S.driver?.status !== 'approved') { await setMode('rider'); return home(); }
      map = makeMap($('#map'), lastPos || C.DEFAULT_CENTER, 16);
      reqLayer.addTo(map);
      onLeave(() => { map._dead = true; try { map.stop(); map.off(); map.remove(); } catch (_) {} });
      const p = await getPos(); if (map._dead) return;
      map.setView(p, 16, { animate: false });
      meMk = L.marker(p, { icon: rkIcon(), zIndexOffset: 1000 }).addTo(map);
      accCircle = L.circle(p, { radius: lastAcc || 20, color: '#2E90FA', weight: 1, fillOpacity: .08, interactive: false }).addTo(map);
      sb.rpc('update_my_location', { lat: p[0], lng: p[1] }).then(() => {});
      let follow = true;
      map.on('dragstart', () => { follow = false; });
      $('#dRecenter').onclick = () => { follow = true; if (lastPos) map.setView(lastPos, 16); };
      const onLoc = (e) => {
        if (map._dead || !meMk) return;
        animateMarker(meMk, e.detail.pos);
        accCircle.setLatLng(e.detail.pos).setRadius(e.detail.acc || 20);
        if (follow) map.panTo(e.detail.pos, { animate: true });
      };
      document.addEventListener('rk-loc', onLoc);
      onLeave(() => document.removeEventListener('rk-loc', onLoc));

      const { data: d } = await sb.from('drivers').select('*').eq('id', S.user.id).single(); S.driver = d;
      const paintOnline = () => {
        const on = S.driver.is_online, b = $('#onlineBtn'); if (!b) return;
        b.style.background = on ? 'var(--green)' : '#5B6660'; b.setAttribute('aria-pressed', on);
        $('#onLbl').textContent = on ? 'متاح' : 'غير متاح';
        $('.ms', b).style.color = on ? 'var(--green)' : '#5B6660';
        if (on) Loc.start(); else Loc.stop();
      };
      paintOnline();
      $('#onlineBtn').onclick = async () => {
        const next = !S.driver.is_online;
        const ok = await safe(() => rpc('set_online', { p_online: next }));
        if (ok === undefined) { if (S.settings?.require_subscription) go('earnings'); return; }
        S.driver.is_online = next; haptic(); paintOnline(); loadReqs();
      };

      rpc('my_earnings', { days: 1 }).then((e) => {
        const t = (e || []).reduce((a, x) => a + x.total, 0), n = (e || []).reduce((a, x) => a + x.trips, 0);
        if ($('#today')) { $('#today').textContent = money(t); $('#todayLbl').textContent = `دخل اليوم · ${num(n)} مشوار`; }
      }).catch(() => {});

      let reqs = [];
      async function loadReqs() {
        const box = $('#reqs'); if (!box) return;
        if (!S.driver.is_online) {
          reqLayer.clearLayers(); $('#reqCount').textContent = '';
          box.innerHTML = `<div class="row gap12 card" style="background:#F4F6F5">${icon('bedtime', '', 'color:var(--ink3);font-size:28px')}<div class="col"><b>إنت غير متاح</b><span class="small muted">دوس «متاح» فوق عشان تبدأ تستلم طلبات</span></div></div>`; return;
        }
        const { data } = await sb.rpc('open_requests_v2', { radius_m: 4000 });
        if (map._dead) return;
        reqs = data || [];
        $('#reqCount').innerHTML = reqs.length ? `<span class="pill yellow" style="background:var(--yellow);color:var(--ink)">${num(reqs.length)} طلب</span>` : '';
        reqLayer.clearLayers();
        reqs.forEach((r, i) => L.marker([r.pickup_lat, r.pickup_lng], { icon: priceIcon(money(r.offered_price), r.is_shared) })
          .on('click', () => openRequest(reqs[i])).addTo(reqLayer));
        box.innerHTML = reqs.length ? reqs.map((r, i) => `<button class="driver-item" data-r="${i}" style="flex-direction:column;align-items:stretch;gap:8px">
          <span class="row gap8"><span class="avatar grey" style="width:40px;height:40px">${initial(r.rider_name)}</span>
            <span class="col grow"><b style="font-size:15px">${esc(r.rider_name || 'راكب')}${r.is_shared ? ` <span class="pill yellow">${icon('group', '', 'font-size:13px')}طرحة · ${num(r.riders)}</span>` : ''}</b>
              <span class="small muted row gap4">${icon('star', 'f', 'font-size:14px;color:var(--star)')}${num(r.rider_rating || 5)} · على بعد ${distStr(r.away_m)}</span></span>
            <span class="price">${money(r.offered_price)}</span></span>
          <span class="row small muted gap4">${icon('trip_origin', '', 'font-size:16px;color:var(--blue)')}<span class="grow" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.pickup_address || '')}</span></span>
          <span class="row small muted gap4">${icon('flag', '', 'font-size:16px')}<span class="grow" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.dropoff_address || '')} · ${num((+r.distance_km).toFixed(1))} كم</span></span>
        </button>`).join('') : `<div class="row gap12 card" style="background:#F4F6F5">${icon('radar', '', 'color:var(--green);font-size:28px')}<div class="col"><b>بندوّر ليك على طلبات…</b><span class="small muted">أول ما راكب قريب يطلب بنوريك</span></div></div>`;
        $$('[data-r]').forEach(b => b.onclick = () => openRequest(reqs[+b.dataset.r]));
      }
      loadReqs();
      every(8000, loadReqs);
      channel('reqs').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trips' }, () => { haptic(); loadReqs(); })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trips' }, (pl) => {
          if (pl.new.driver_id === S.user.id && pl.new.status === 'accepted') { haptic(); toast('الراكب قبل عرضك!', 'success'); go('driverTrip', { id: pl.new.id }, { root: true }); }
          else loadReqs();
        }).subscribe();
    }
  };
};
function openRequest(r) {
  const r100 = (x) => Math.max(100, Math.round(x / 100) * 100);
  const counters = [r.offered_price + r100(r.offered_price * 0.1), r.offered_price + r100(r.offered_price * 0.2), r.offered_price + r100(r.offered_price * 0.3)];
  let left = 20;
  modal(`<div class="row" style="justify-content:space-between">
      <div class="col gap4"><span class="row gap4 small" style="color:#B54708;font-weight:600">${icon('notifications_active', 'f', 'font-size:16px')}طلب جديد</span>
        <h2 style="margin:0;font-size:22px">مشوار ${num((+r.distance_km).toFixed(1))} كم</h2></div>
      <div class="timer" id="tm" style="background:conic-gradient(var(--yellow) 0 100%, var(--bg) 0)"><div id="tmV">${num(left)}</div></div></div>
    <div class="card row gap12" style="background:#F4F6F5"><span class="avatar grey">${initial(r.rider_name)}</span>
      <div class="col grow"><b>${esc(r.rider_name || 'راكب')}</b><span class="small muted row gap4">${icon('star', 'f', 'font-size:14px;color:var(--star)')}${num(r.rider_rating || 5)}</span></div>
      <span class="small muted row gap4">${icon('near_me', '', 'font-size:18px')}${distStr(r.away_m)}</span></div>
    <div class="route-box" style="background:transparent;padding:0 4px"><div class="route-dots"><span class="dot-a"></span><span class="dash"></span><span class="dot-b"></span></div>
      <div class="col grow gap12"><div class="col"><span class="small muted">الاستلام</span><b style="font-size:15px">${esc(r.pickup_address || '')}</b></div>
      <div class="col"><span class="small muted">الوجهة</span><b style="font-size:15px">${esc(r.dropoff_address || '')}</b></div></div></div>
    <div class="card row" style="background:var(--yellow-soft);justify-content:space-between"><span class="row gap4 muted" style="font-size:14px">${icon('payments', '', 'color:var(--green)')}عرض الراكب · كاش</span><b style="font-size:26px">${money(r.offered_price)}</b></div>
    <div class="col gap8"><b class="row gap4" style="font-size:14px">${icon('sell', '', 'font-size:18px')}أو اقترح سعرك</b>
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">${counters.map(c => `<button class="btn ghost sm" data-c="${c}">${num(c)}</button>`).join('')}</div></div>
    <div class="row gap8"><button class="btn ghost" id="rej" aria-label="تجاهل" style="width:64px;background:var(--red-soft);color:var(--red);border-color:#F3C7C3">${icon('close')}</button>
      <button class="btn" id="acc">${icon('check_circle', '', 'color:var(--yellow)')}قبول · ${money(r.offered_price)}</button></div>`,
  (o, close) => {
    const tick = setInterval(() => {
      left--; if (!document.body.contains(o)) return clearInterval(tick);
      $('#tmV', o).textContent = num(left);
      $('#tm', o).style.background = `conic-gradient(var(--yellow) 0 ${left / 20 * 100}%, var(--bg) 0)`;
      if (left <= 0) { clearInterval(tick); close(); }
    }, 1000);
    $('#rej', o).onclick = () => { clearInterval(tick); close(); };
    $('#acc', o).onclick = async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      const ok = await safe(() => rpc('accept_trip', { p_trip: r.id }));
      clearInterval(tick); close();
      if (ok !== undefined) { haptic(); go('driverTrip', { id: r.id }, { root: true }); }
    };
    $$('[data-c]', o).forEach(b => b.onclick = async () => {
      const ok = await safe(() => rpc('make_offer', { p_trip: r.id, p_price: +b.dataset.c }), 'اترسل عرضك للراكب — منتظرين رده');
      if (ok !== undefined) { clearInterval(tick); close(); }
    });
  });
}

/* ---------- Driver: Active trip ---------- */
Screens.driverTrip = ({ id }) => {
  let map, trip, rider, meMk, shares = [], paxLayer;
  const NEXT = {
    accepted: ['arriving', 'navigation', 'أنا في الطريق للراكب'],
    arriving: ['arrived', 'where_to_vote', 'وصلت مكان الراكب'],
    arrived: ['in_progress', 'play_arrow', 'ابدأ المشوار'],
    in_progress: ['completed', 'flag', 'وصلنا — إنهاء المشوار']
  };
  return {
    html: `<div class="screen">
      <div id="map" class="map"></div>
      <div class="map-top"><div class="loc-box" style="background:var(--ink);color:#fff"><span class="row gap8" style="font-size:14px">${icon('electric_rickshaw', 'f', 'font-size:20px;color:var(--yellow)')}<span id="stTxt">…</span></span></div></div>
      <div class="sheet" id="sheet"><div class="grab"></div><div class="col" style="align-items:center;padding:30px"><div class="spinner"></div></div></div>
    </div>`,
    async mount() {
      trip = await safe(() => getTrip(id));
      if (!trip) return home();
      if (trip.status === 'completed') return go('rating', { id }, { root: true });
      if (trip.status === 'cancelled') { toast('المشوار اتلغى'); return home(); }
      rider = await getProfile(trip.rider_id);
      Loc.start(); // الراكب يتابعك
      if (!$('#stTxt')) return;
      map = makeMap($('#map'), trip._pickup, 15);
      onLeave(() => { map._dead = true; try { map.stop(); map.off(); map.remove(); } catch (_) {} });
      L.marker(trip._pickup, { icon: meIcon() }).addTo(map);
      L.marker(trip._dropoff, { icon: destIcon() }).addTo(map);
      const p = await getPos(); if (map._dead) return; meMk = L.marker(p, { icon: rkIcon(), zIndexOffset: 1000 }).addTo(map);
      const rf = routeFollower(map);
      paxLayer = L.layerGroup().addTo(map);
      const paintPax = async () => {
        if (!trip.is_shared || map._dead) return;
        shares = await loadShares(id); if (map._dead) return;
        paxLayer.clearLayers();
        shares.filter(x => !x.is_owner).forEach(x => {
          L.marker([x.pickup_lat, x.pickup_lng], { icon: priceIcon(esc((x.full_name || '').split(' ')[0]), true) }).addTo(paxLayer);
          L.marker([x.dropoff_lat, x.dropoff_lng], { icon: destIcon() }).addTo(paxLayer);
        });
      };
      paintPax();
      let follow = true;
      map.on('dragstart', () => { follow = false; });
      const refreshRoute = async () => {
        if (!lastPos || map._dead) return;
        animateMarker(meMk, lastPos);
        const target = trip.status === 'in_progress' ? trip._dropoff : trip._pickup;
        const r = await rf.update(lastPos, target);
        if (r && $('#navInfo')) $('#navInfo').innerHTML = `<b style="font-size:20px">${num(r.min)} د</b><span class="small muted">${num(r.km.toFixed(1))} كم ${trip.status === 'in_progress' ? 'للوجهة' : 'للراكب'}</span>`;
        if (follow && !map._dead) map.panTo(lastPos, { animate: true });
      };
      const first = await rf.update(p, trip.status === 'in_progress' ? trip._dropoff : trip._pickup);
      if (map._dead) return;
      map.fitBounds(L.polyline(first.coords).getBounds().pad(0.3), { paddingBottomRight: [0, 340] });
      every(5000, refreshRoute);
      const onMeter = (e) => { if ($('#mKm')) { $('#mKm').textContent = num(e.detail.toFixed(2)); $('#mFare').textContent = money(fareFor(e.detail)); } };
      document.addEventListener('rk-meter', onMeter);
      onLeave(() => document.removeEventListener('rk-meter', onMeter));
      if (trip.status === 'in_progress') Meter.start(id, trip.traveled_km);

      const render = async () => {
        if (!$('#stTxt')) return;
        $('#stTxt').textContent = STATUS_AR[trip.status];
        const nx = NEXT[trip.status];
        const target = trip.status === 'in_progress' ? trip._dropoff : trip._pickup;
        const unread = await unreadCount(id);
        if (!$('#sheet')) return;
        $('#sheet').innerHTML = `<div class="grab"></div>
          <div class="row gap12"><div class="avatar grey" style="width:54px;height:54px;border-radius:16px">${rider.avatar_url ? `<img src="${esc(rider.avatar_url)}" alt="">` : initial(rider.full_name)}</div>
            <div class="col grow gap4"><b style="font-size:17px">${esc(rider.full_name || 'الراكب')}</b><span class="small muted row gap4">${icon('star', 'f', 'font-size:14px;color:var(--star)')}${num(rider.rating_avg || 5)}</span></div>
            <b class="price" style="font-size:22px">${trip.is_shared && shares[0] ? money(shares[0].total) : money(trip.final_price)}</b></div>
          <div class="route-box"><div class="route-dots"><span class="dot-a"></span><span class="dash"></span><span class="dot-b"></span></div>
            <div class="col grow gap8"><span style="font-size:14px;${trip.status === 'in_progress' ? 'color:var(--ink3)' : 'font-weight:600'}">${esc(trip.pickup_address || '')}</span>
            <span style="font-size:14px;${trip.status === 'in_progress' ? 'font-weight:600' : 'color:var(--ink3)'}">${esc(trip.dropoff_address || '')}</span></div></div>
          <div class="card row gap12" style="background:#F4F6F5;padding:10px 14px">${icon('navigation', 'f', 'color:var(--blue)')}<div class="col grow" id="navInfo"><span class="small muted">بنحسب الطريق…</span></div>
            <button class="icon-btn" id="recenter" aria-label="تتبع موقعي" style="background:#fff">${icon('my_location')}</button></div>
          ${trip.status === 'in_progress' ? meterHtml(trip, Meter.km || +trip.traveled_km || 0) : ''}
          ${trip.is_shared ? sharesHtml(shares = await loadShares(id), { driver: true }) : ''}
          <div class="actions3">
            <a class="act" href="https://www.google.com/maps/dir/?api=1&destination=${target[0]},${target[1]}&travelmode=driving">${icon('map')}خرائط جوجل</a>
            <button class="act dark" id="chatBtn">${icon('chat')}دردشة${unread ? `<span class="badge">${num(unread)}</span>` : ''}</button>
            <a class="act" href="tel:${esc(rider.phone || '')}">${icon('call')}اتصال</a>
          </div>
          ${nx ? `<button class="btn ${trip.status === 'in_progress' ? 'yellow' : ''}" id="nextBtn" style="height:60px">${icon(nx[1])}${nx[2]}</button>` : ''}
          <div class="row gap8">${trip.status !== 'in_progress' ? `<button class="btn danger" id="cancelBtn">${icon('close')}إلغاء المشوار</button>` : ''}
            <button class="btn danger" id="reportBtn" style="color:var(--ink3)">${icon('flag')}إبلاغ</button></div>`;
        $('#chatBtn').onclick = () => go('chat', { id });
        $('#reportBtn').onclick = () => openReport({ tripId: id, reportedId: trip.rider_id, reportedName: rider.full_name });
        $('#recenter').onclick = () => { follow = true; refreshRoute(); if (lastPos) map.setView(lastPos, 17); };
        refreshRoute();
        $('#nextBtn') && ($('#nextBtn').onclick = async (e) => {
          const btn = e.currentTarget;
          if (nx[0] === 'completed' && trip.is_shared && !(await confirmBox('تنهي الطرحة؟', `استلم من كل راكب نصيبه: ${shares.map(x => (x.full_name || '').split(' ')[0] + ' ' + money(x.share)).join('، ')} — الإجمالي ${money(shares[0]?.total || trip.final_price)}`, 'إنهاء'))) return;
          if (nx[0] === 'completed' && !trip.is_shared && !(await confirmBox('تنهي المشوار؟', `السعر المتفق عليه ${money(trip.final_price)} — العداد قرا ${num((Meter.km || 0).toFixed(1))} كم (${money(fareFor(Meter.km || 0))}). استلم المبلغ كاش من الراكب.`, 'إنهاء'))) return;
          btn.disabled = true;
          const ok = await safe(() => rpc('set_trip_status', { p_trip: id, p_status: nx[0] }));
          if (ok !== undefined) {
            haptic(); trip.status = nx[0];
            if (nx[0] === 'in_progress') Meter.start(id, 0);
            if (nx[0] === 'completed') { await Meter.stop(true); return go('rating', { id }, { root: true }); }
            render();
          } else btn.disabled = false;
        });
        $('#cancelBtn') && ($('#cancelBtn').onclick = async () => {
          if (!(await confirmBox('تلغي المشوار؟', 'الراكب منتظرك. الإلغاء المتكرر بيأثر على حسابك.', 'إلغاء', true))) return;
          const ok = await safe(() => rpc('set_trip_status', { p_trip: id, p_status: 'cancelled', p_reason: 'driver_cancel' }));
          if (ok !== undefined) home();
        });
      };
      render();
      channel('dtrip').on('postgres_changes', { event: '*', schema: 'public', table: 'trip_passengers', filter: `trip_id=eq.${id}` }, (pl) => {
        haptic(); toast(pl.new && pl.new.status === 'joined' ? 'راكب جديد انضم للطرحة' : 'راكب انسحب من الطرحة'); paintPax(); render();
      }).on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trips', filter: `id=eq.${id}` }, (pl) => {
        trip.status = pl.new.status;
        if (trip.status === 'cancelled') { toast('الراكب لغى المشوار', 'error'); return home(); }
        render();
      }).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `trip_id=eq.${id}` }, (pl) => {
        if (pl.new.sender_id !== S.user.id) { haptic(); toast('رسالة جديدة من الراكب'); render(); }
      }).subscribe();
    }
  };
};

/* ---------- Driver: Earnings & subscription ---------- */
Screens.earnings = () => ({
  html: `<div class="screen" style="background:var(--bg)"><div class="scroll">
    <div style="background:var(--ink);color:#fff;padding:calc(var(--safe-top) + 14px) 16px 24px;border-radius:0 0 28px 28px" class="col gap16">
      <div class="row" style="justify-content:space-between"><b style="font-size:16px">دخلي</b><span class="small" style="color:#A9B5AE">آخر ٧ أيام</span></div>
      <div class="col gap4"><span class="small" style="color:#A9B5AE">الإجمالي</span><span style="font-size:34px;font-weight:700" id="eTot">…</span></div>
      <div class="bars" id="bars"></div>
    </div>
    <div class="pad" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px" id="eStats"></div>
    <div class="pad" style="padding-top:0" id="sub"></div>
  </div></div>${nav('earnings')}`,
  async mount(root) {
    bindNav(root);
    const rows = await rpc('my_earnings', { days: 7 }).catch(() => []) || [];
    const days = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d); }
    const key = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Khartoum' });
    const map = {}; rows.forEach(r => map[r.day] = r);
    const max = Math.max(1, ...rows.map(r => r.total));
    const total = rows.reduce((a, r) => a + r.total, 0), trips = rows.reduce((a, r) => a + r.trips, 0);
    $('#eTot').innerHTML = `${num(total)} <span style="font-size:16px;font-weight:500;color:var(--yellow)">جنيه</span>`;
    $('#bars').innerHTML = days.map((d, i) => {
      const r = map[key(d)]; const h = r ? Math.max(6, r.total / max * 100) : 4;
      return `<div><i style="height:${h}%;${i === 6 ? 'background:var(--yellow)' : ''}"></i><span style="${i === 6 ? 'color:#fff' : ''}">${d.toLocaleDateString('ar-EG', { weekday: 'short' })}</span></div>`;
    }).join('');
    $('#eStats').innerHTML = `<div class="stat">${icon('electric_rickshaw', '', 'font-size:20px')}<b>${num(trips)}</b><span class="small muted">مشوار</span></div>
      <div class="stat">${icon('payments', '', 'font-size:20px;color:var(--green)')}<b>${num(trips ? Math.round(total / trips) : 0)}</b><span class="small muted">متوسط المشوار</span></div>
      <div class="stat">${icon('star', 'f', 'font-size:20px;color:var(--star)')}<b>${num(S.profile?.rating_avg || 5)}</b><span class="small muted">تقييمك</span></div>`;
    renderSub();
  }
});
async function renderSub() {
  const st = S.settings || {};
  const { data } = await sb.from('subscriptions').select('*').eq('driver_id', S.user.id).order('created_at', { ascending: false }).limit(1);
  const s = data && data[0];
  const active = s && s.status === 'active' && new Date(s.ends_at) > new Date();
  const pending = s && s.status === 'pending';
  const daysLeft = active ? Math.ceil((new Date(s.ends_at) - new Date()) / 86400000) : 0;
  const box = $('#sub'); if (!box) return;
  box.innerHTML = `<div class="card col gap12" style="border-radius:22px;padding:16px">
    <div class="row gap12"><span class="rk" style="background:var(--yellow-soft)">${icon('workspace_premium', 'f')}</span>
      <div class="col grow"><b>الاشتراك الشهري</b><span class="small muted">${st.require_subscription ? 'بدون عمولة على المشاوير' : 'مجاني حالياً — فترة الإطلاق'}</span></div>
      <span class="pill ${active ? 'green' : pending ? 'yellow' : 'grey'}">${active ? 'فعّال' : pending ? 'قيد المراجعة' : 'غير مشترك'}</span></div>
    ${active ? `<div class="col gap4"><div class="row small muted" style="justify-content:space-between"><span>باقي ${num(daysLeft)} يوم</span><span>ينتهي ${new Date(s.ends_at).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' })}</span></div>
      <div style="height:8px;border-radius:8px;background:#EEF1EF;overflow:hidden"><div style="width:${Math.min(100, daysLeft / 30 * 100)}%;height:100%;background:var(--yellow)"></div></div></div>` : ''}
    ${pending ? `<p class="small muted" style="margin:0">وصلنا إيصالك، بنفعّل اشتراكك بعد ما نتأكد من التحويل.</p>`
      : `<button class="btn" id="renew">${icon('account_balance', '', 'color:var(--yellow)')}${active ? 'جدّد' : 'اشترك'} عبر بنكك · ${money(st.subscription_price)}</button>`}
  </div>`;
  const r = $('#renew');
  r && (r.onclick = () => modal(`<h2 style="margin:0;font-size:20px">الدفع عبر بنكك</h2>
    <div class="card col gap8" style="background:#F4F6F5">
      <div class="row" style="justify-content:space-between"><span class="muted small">المبلغ</span><b>${money(st.subscription_price)}</b></div>
      <div class="row" style="justify-content:space-between"><span class="muted small">رقم الحساب</span><b style="direction:ltr">${esc(st.bankak_account)}</b></div>
      <div class="row" style="justify-content:space-between"><span class="muted small">الاسم</span><b>${esc(st.bankak_name)}</b></div></div>
    <p class="small muted" style="margin:0;line-height:1.6">حوّل المبلغ من تطبيق بنكك، وبعدها اكتب رقم العملية وارفع صورة الإشعار.</p>
    <div class="field"><label for="ref">رقم العملية</label><input class="input" id="ref" inputmode="numeric"></div>
    <label class="doc" id="rcLbl"><span class="rk">${icon('receipt')}</span><span class="col grow"><b>صورة الإشعار</b><span class="small muted" id="rcTxt">اختار صورة</span></span>${icon('add_a_photo')}<input type="file" accept="image/*" id="rc"></label>
    <button class="btn" id="sendSub">إرسال</button>`, (o, close) => {
    let file = null;
    $('#rc', o).onchange = (e) => { file = e.target.files[0]; if (file) { $('#rcTxt', o).textContent = 'اتختارت الصورة'; $('#rcLbl', o).classList.add('done'); } };
    $('#sendSub', o).onclick = async (e) => {
      const btn = e.currentTarget;
      const ref = $('#ref', o).value.trim();
      if (!ref && !file) return toast('اكتب رقم العملية أو ارفع الإشعار', 'error');
      btn.disabled = true;
      const ok = await safe(async () => {
        let path = null;
        if (file) path = await uploadImage('receipts', `${S.user.id}/${Date.now()}.jpg`, file);
        const { error } = await sb.from('subscriptions').insert({ driver_id: S.user.id, amount: st.subscription_price, bankak_ref: ref || null, receipt_path: path });
        if (error) throw error; return true;
      }, 'اترسل — بنراجعه قريب');
      if (ok) { close(); renderSub(); } else btn.disabled = false;
    };
  }));
}




/* ---------- نظام البلاغات ---------- */
const REPORT_CATS = [
  ['safety', 'gpp_maybe', 'خطر على السلامة'], ['harassment', 'front_hand', 'تحرش أو إساءة'],
  ['price', 'payments', 'مشكلة في السعر أو الدفع'], ['behavior', 'sentiment_dissatisfied', 'سلوك سيء'],
  ['route', 'alt_route', 'طريق طويل أو غلط'], ['vehicle', 'electric_rickshaw', 'حالة الركشة'],
  ['no_show', 'person_off', 'ما حضر أو اتأخر كتير'], ['other', 'more_horiz', 'حاجة تانية']
];
const REPORT_ST = { new: ['yellow', 'جديد'], reviewing: ['grey', 'قيد المراجعة'], resolved: ['green', 'اتحل'], dismissed: ['red', 'مرفوض'] };
function openReport({ tripId = null, reportedId = null, reportedName = '' } = {}) {
  let cat = null, file = null;
  modal(`<div class="row gap8">${icon('flag', 'f', 'color:var(--red)')}<h2 style="margin:0;font-size:20px">بلاغ${reportedName ? ' عن ' + esc(reportedName) : ''}</h2></div>
    <div class="card row gap8" style="background:var(--red-soft);align-items:flex-start;padding:10px 12px">${icon('emergency', '', 'color:var(--red);font-size:20px')}
      <span class="small" style="color:#7A271A;line-height:1.6">لو في خطر حالاً، اتصل بالشرطة على <a href="tel:999" style="color:#7A271A;font-weight:700">٩٩٩</a> أول.</span></div>
    <b style="font-size:14px">نوع المشكلة</b>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">${REPORT_CATS.map(([k, ic, l]) =>
      `<button type="button" class="chip" data-cat="${k}" aria-pressed="false" style="height:auto;min-height:44px;padding:8px 10px;border-radius:14px;justify-content:flex-start;text-align:right">${icon(ic, '', 'font-size:18px')}${l}</button>`).join('')}</div>
    <div class="field"><label for="rpD">التفاصيل</label>
      <textarea class="input" id="rpD" rows="3" style="height:auto;padding:12px 16px;resize:none" placeholder="احكي لينا الحصل…"></textarea></div>
    <label class="doc" id="rpImgL" style="padding:10px 14px"><span class="rk" style="width:40px;height:40px">${icon('add_a_photo')}</span><span class="col grow"><b style="font-size:14px">صورة (اختياري)</b><span class="small muted" id="rpImgT">إثبات أو صورة للمشكلة</span></span><input type="file" accept="image/*" id="rpImg"></label>
    <button class="btn" id="rpSend" style="background:var(--red)">إرسال البلاغ</button>
    <p class="small muted" style="margin:0;text-align:center">بلاغك سري — ${reportedName ? 'الطرف التاني ما بيعرف إنك بلّغت' : 'فريق ركشتي بس بيشوفه'}</p>`,
  (o, close) => {
    $$('[data-cat]', o).forEach(b => b.onclick = () => {
      cat = b.dataset.cat;
      $$('[data-cat]', o).forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
    });
    $('#rpImg', o).onchange = (e) => { file = e.target.files[0]; if (file) { $('#rpImgT', o).textContent = 'اتختارت الصورة'; $('#rpImgL', o).classList.add('done'); } };
    $('#rpSend', o).onclick = async (e) => {
      const btn = e.currentTarget;
      if (!cat) return toast('اختار نوع المشكلة', 'error');
      const details = $('#rpD', o).value.trim();
      if (cat === 'other' && details.length < 5) return toast('اكتب تفاصيل المشكلة', 'error');
      btn.disabled = true;
      const ok = await safe(async () => {
        let image_path = null;
        if (file) image_path = await uploadImage('reports', `${S.user.id}/${Date.now()}.jpg`, file);
        const { error } = await sb.from('reports').insert({ trip_id: tripId, reporter_id: S.user.id, reported_id: reportedId, category: cat, details: details || null, image_path });
        if (error) throw error; return true;
      }, 'البلاغ وصل — بنراجعه ونتواصل معاك');
      if (ok) close(); else btn.disabled = false;
    };
  });
}

Screens.myReports = () => ({
  html: `<div class="screen" style="background:var(--bg)">
    <div class="topbar"><button class="icon-btn" data-back aria-label="رجوع">${icon('arrow_forward')}</button><h1>بلاغاتي</h1>
      <button class="icon-btn" id="newRp" aria-label="بلاغ جديد">${icon('add')}</button></div>
    <div class="scroll pad col gap8" id="rpList"><div class="col" style="align-items:center;padding:30px"><div class="spinner"></div></div></div></div>`,
  async mount(root) {
    bindBack(root);
    $('#newRp').onclick = () => openReport();
    const { data } = await sb.from('reports').select('*').eq('reporter_id', S.user.id).order('created_at', { ascending: false });
    const list = data || [];
    const box = $('#rpList'); if (!box) return;
    if (!list.length) { box.innerHTML = `<div class="empty">${icon('flag')}<b>ما عندك بلاغات</b><span class="small">لو حصلت مشكلة في مشوار، بلّغ من شاشة المشوار أو من سجل مشاويرك</span></div>`; return; }
    box.innerHTML = list.map(r => {
      const c = REPORT_CATS.find(x => x[0] === r.category) || REPORT_CATS[7], st = REPORT_ST[r.status];
      return `<div class="card col gap8"><div class="row gap8">${icon(c[1], '', 'color:var(--red)')}<b class="grow">${c[2]}</b><span class="pill ${st[0]}">${st[1]}</span></div>
        ${r.details ? `<span class="small" style="line-height:1.6">${esc(r.details)}</span>` : ''}
        <span class="small muted">${new Date(r.created_at).toLocaleString('ar-EG')}</span>
        ${r.admin_note ? `<div class="card" style="background:var(--green-soft);padding:10px"><span class="small"><b>رد فريق ركشتي:</b> ${esc(r.admin_note)}</span></div>` : ''}</div>`;
    }).join('');
  }
});

/* ---------- Support chat (user ↔ admin) ---------- */
Screens.support = ({ thread } = {}) => {
  const asAdmin = !!thread && thread !== S.user.id;
  const tid = thread || S.user.id;
  const TOPICS = ['مشكلة في مشوار', 'مشكلة في الدفع', 'تسجيل السواق', 'اقتراح', 'بلاغ عن سواق أو راكب'];
  return {
    html: `<div class="screen" style="background:var(--bg)">
      <div class="topbar">
        <button class="icon-btn" data-back aria-label="رجوع">${icon('arrow_forward')}</button>
        <div class="avatar" style="width:42px;height:42px;background:${asAdmin ? '#E3E8E5' : 'var(--ink)'}">${asAdmin ? '؟' : icon('support_agent', '', 'color:var(--yellow)')}</div>
        <div class="col grow"><b id="sTitle" style="font-size:16px">${asAdmin ? '…' : 'دعم ركشتي'}</b><span class="small muted" id="sSub">${asAdmin ? '' : 'بنرد عليك في أقرب وقت'}</span></div>
        ${asAdmin ? `<a class="icon-btn" id="sCall" aria-label="اتصال">${icon('call')}</a><button class="icon-btn" id="sClose" aria-label="قفل المحادثة">${icon('task_alt')}</button>` : ''}
      </div>
      <div class="scroll pad col gap8" id="sMsgs">
        ${asAdmin ? '' : `<div class="card col gap8" style="align-self:center;text-align:center;max-width:90%"><span class="rk y" style="align-self:center">${icon('waving_hand')}</span><b>أهلاً ${esc((S.profile?.full_name || '').split(' ')[0])}!</b><span class="small muted" style="line-height:1.6">اكتب مشكلتك أو سؤالك، وفريق ركشتي بيرد عليك هنا. ممكن ترسل صورة كمان.</span></div>`}
      </div>
      ${asAdmin ? '' : `<div class="hscroll" id="sTopics">${TOPICS.map(t => `<button class="chip" data-tp="${esc(t)}">${esc(t)}</button>`).join('')}</div>`}
      <form class="composer" id="sForm">
        <label class="round" aria-label="إرسال صورة" style="cursor:pointer">${icon('image')}<input type="file" accept="image/*" id="sImg" class="sr"></label>
        <label for="sIn" class="sr">اكتب رسالة</label>
        <input id="sIn" placeholder="اكتب رسالتك…" autocomplete="off" enterkeyhint="send">
        <button class="round y" aria-label="إرسال">${icon('send', 'f', 'transform:scaleX(-1)')}</button>
      </form></div>`,
    async mount(root) {
      bindBack(root);
      const box = $('#sMsgs');
      let ready, readyP = new Promise(r => ready = r), send = async () => {};
      $('#sForm').onsubmit = async (e) => { e.preventDefault(); const v = $('#sIn').value.trim(); $('#sIn').value = ''; await readyP; send(v); };
      if (!asAdmin) await sb.from('support_threads').upsert({ user_id: tid }, { onConflict: 'user_id', ignoreDuplicates: true });
      else {
        const p = await getProfile(tid);
        $('#sTitle').textContent = p.full_name || 'مستخدم';
        $('#sSub').textContent = p.phone || '';
        $('#sCall').href = 'tel:' + (p.phone || '');
        $('#sClose').onclick = async () => { await safe(() => rpc('support_set_status', { p_thread: tid, p_status: 'closed' }), 'المحادثة اتقفلت'); back(); };
      }
      const mine = (m) => asAdmin ? m.from_admin : !m.from_admin;
      const urlCache = {};
      const render = async (m) => {
        if ($(`[data-id="${m.id}"]`, box)) return;
        const d = document.createElement('div');
        d.className = 'bubble ' + (mine(m) ? 'me' : 'them'); d.dataset.id = m.id;
        let img = '';
        if (m.image_path) {
          urlCache[m.image_path] = urlCache[m.image_path] || (await sb.storage.from('support').createSignedUrl(m.image_path, 3600)).data?.signedUrl;
          img = `<a href="${urlCache[m.image_path]}"><img src="${urlCache[m.image_path]}" alt="صورة" style="max-width:220px;border-radius:12px;display:block"></a>`;
        }
        const who = !mine(m) && !asAdmin ? `<span class="small" style="font-weight:600;color:var(--green-ink)">فريق ركشتي</span>` : '';
        d.innerHTML = `${who}${img}${m.body ? `<span>${esc(m.body)}</span>` : ''}<span class="t">${timeStr(m.created_at)}</span>`;
        box.appendChild(d);
        box.scrollTop = box.scrollHeight;
      };
      const { data } = await sb.from('support_messages').select('*').eq('thread_id', tid).order('created_at');
      for (const m of data || []) await render(m);
      rpc('support_mark_read', { p_thread: tid }).catch(() => {});
      channel('sup').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'support_messages', filter: `thread_id=eq.${tid}` }, async (p) => {
        await render(p.new);
        if (!mine(p.new)) { haptic(); rpc('support_mark_read', { p_thread: tid }).catch(() => {}); }
      }).subscribe();
      send = async (body, image_path) => {
        if (!body && !image_path) return;
        const { data: m, error } = await sb.from('support_messages').insert({ thread_id: tid, sender_id: S.user.id, from_admin: asAdmin, body: body || null, image_path: image_path || null }).select().single();
        if (error) return toast(errMsg(error), 'error');
        render(m);
        const tp = $('#sTopics'); if (tp) tp.remove();
      };
      ready();
      $$('[data-tp]').forEach(b => b.onclick = () => { const i = $('#sIn'); i.value = b.dataset.tp + ': '; i.focus(); });
      $('#sImg').onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        toast('بنرسل الصورة…');
        const path = await safe(() => uploadImage('support', `${tid}/${Date.now()}.jpg`, f));
        if (path) send(null, path);
      };
    }
  };
};

/* ---------- Admin ---------- */
Screens.admin = ({ tab = 'support' } = {}) => ({
  html: `<div class="screen" style="background:var(--bg)">
    <div class="topbar"><button class="icon-btn" data-back aria-label="رجوع">${icon('arrow_forward')}</button><h1>لوحة الإدارة</h1></div>
    <div class="hscroll" role="tablist" style="padding-top:12px;padding-bottom:4px">
      ${[['support', 'support_agent', 'الدعم'], ['reports', 'flag', 'البلاغات'], ['drivers', 'badge', 'السواقين'], ['subs', 'workspace_premium', 'الاشتراكات'], ['stats', 'monitoring', 'الأرقام'], ['settings', 'tune', 'الإعدادات']].map(([k, ic, l]) => `<button role="tab" data-t="${k}" class="chip ${tab === k ? 'on' : ''}" aria-selected="${tab === k}">${icon(ic, '', 'font-size:18px')}${l}</button>`).join('')}
    </div>
    <div class="scroll pad col gap8" id="adm"><div class="col" style="align-items:center;padding:30px"><div class="spinner"></div></div></div>
  </div>`,
  async mount(root) {
    bindBack(root);
    $$('[data-t]').forEach(b => b.onclick = () => go('admin', { tab: b.dataset.t }, { replace: true }));
    const box = $('#adm');
    const signed = async (bucket, path) => (await sb.storage.from(bucket).createSignedUrl(path, 3600)).data?.signedUrl;
    const DOCN = { photo: 'الصورة', license: 'الرخصة', vehicle_registration: 'شهادة البحث', vehicle_photo: 'الركشة' };

    if (tab === 'support') {
      const load = async () => {
        const { data: th } = await sb.from('support_threads').select('*').order('last_at', { ascending: false }).limit(100);
        const list = th || [];
        if (!list.length) { box.innerHTML = `<div class="empty">${icon('support_agent')}<b>ما في محادثات دعم</b></div>`; return; }
        const { data: ps } = await sb.from('profiles').select('id,full_name,phone').in('id', list.map(t => t.user_id));
        const pm = {}; (ps || []).forEach(p => pm[p.id] = p);
        box.innerHTML = list.map(t => {
          const p = pm[t.user_id] || {};
          return `<button class="list-btn" data-th="${t.user_id}" style="align-items:flex-start">
            <span class="avatar grey" style="width:44px;height:44px">${initial(p.full_name)}</span>
            <span class="col grow gap4" style="min-width:0"><span class="row" style="justify-content:space-between"><b>${esc(p.full_name || 'مستخدم')}</b><span class="small muted">${t.last_at ? timeStr(t.last_at) : ''}</span></span>
              <span class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.last_message || '')}</span></span>
            ${t.unread_admin ? `<span class="badge" style="position:static">${num(t.unread_admin)}</span>` : t.status === 'closed' ? '<span class="pill grey">مقفولة</span>' : ''}
          </button>`;
        }).join('');
        $$('[data-th]').forEach(b => b.onclick = () => go('support', { thread: b.dataset.th }));
      };
      await load();
      channel('adm-sup').on('postgres_changes', { event: '*', schema: 'public', table: 'support_threads' }, load).subscribe();
    }


    if (tab === 'reports') {
      const load = async () => {
        const { data } = await sb.from('reports').select('*').order('created_at', { ascending: false }).limit(100);
        const list = (data || []).sort((a, b) => (['new', 'reviewing'].includes(b.status) - ['new', 'reviewing'].includes(a.status)));
        if (!list.length) { box.innerHTML = `<div class="empty">${icon('flag')}<b>ما في بلاغات</b></div>`; return; }
        const ids = [...new Set(list.flatMap(r => [r.reporter_id, r.reported_id]).filter(Boolean))];
        const [{ data: ps }, { data: ds }, cnt] = await Promise.all([
          sb.from('profiles').select('id,full_name,phone').in('id', ids),
          sb.from('drivers').select('id,status').in('id', ids),
          rpc('report_counts', { p_users: ids }).catch(() => [])
        ]);
        const pm = {}, dm = {}, cm = {};
        (ps || []).forEach(p => pm[p.id] = p); (ds || []).forEach(d => dm[d.id] = d); (cnt || []).forEach(c => cm[c.user_id] = c);
        const urls = {}; await Promise.all(list.filter(r => r.image_path).map(async r => { urls[r.id] = (await sb.storage.from('reports').createSignedUrl(r.image_path, 3600)).data?.signedUrl; }));
        if (!$('#adm')) return;
        box.innerHTML = list.map(r => {
          const c = REPORT_CATS.find(x => x[0] === r.category) || REPORT_CATS[7], st = REPORT_ST[r.status];
          const rep_ = pm[r.reporter_id] || {}, tgt = pm[r.reported_id], drv = dm[r.reported_id], n = cm[r.reported_id];
          const open = ['new', 'reviewing'].includes(r.status);
          return `<div class="card col gap8" style="${r.category === 'safety' || r.category === 'harassment' ? 'border:2px solid var(--red)' : ''}">
            <div class="row gap8">${icon(c[1], '', 'color:var(--red)')}<b class="grow">${c[2]}</b><span class="pill ${st[0]}">${st[1]}</span></div>
            <span class="small">من: <b>${esc(rep_.full_name || '')}</b> <a href="tel:${esc(rep_.phone || '')}" style="direction:ltr">${esc(rep_.phone || '')}</a></span>
            ${tgt ? `<span class="small">ضد: <b>${esc(tgt.full_name || '')}</b> ${drv ? '(سواق)' : '(راكب)'} <a href="tel:${esc(tgt.phone || '')}" style="direction:ltr">${esc(tgt.phone || '')}</a>
              ${n && n.total > 1 ? `<span class="pill red">${num(n.total)} بلاغات ضده</span>` : ''}</span>` : '<span class="small muted">بلاغ عام (بدون مشوار)</span>'}
            ${r.details ? `<span style="font-size:14px;line-height:1.6;background:#F4F6F5;border-radius:12px;padding:10px">${esc(r.details)}</span>` : ''}
            ${urls[r.id] ? `<a href="${urls[r.id]}"><img src="${urls[r.id]}" alt="مرفق" style="width:100%;max-height:220px;object-fit:contain;border-radius:12px;background:#F4F6F5"></a>` : ''}
            <span class="small muted">${new Date(r.created_at).toLocaleString('ar-EG')}</span>
            ${r.admin_note ? `<span class="small" style="color:var(--green-ink)"><b>ردك:</b> ${esc(r.admin_note)}</span>` : ''}
            ${open ? `<div class="row gap8" style="flex-wrap:wrap">
              ${r.status === 'new' ? `<button class="btn sm ghost" data-rs="${r.id}:reviewing" style="flex:1">قيد المراجعة</button>` : ''}
              <button class="btn sm" data-rs="${r.id}:resolved" style="flex:1">${icon('check')}اتحل</button>
              <button class="btn sm ghost" data-rs="${r.id}:dismissed" style="flex:1;color:var(--red)">رفض</button>
              ${drv && drv.status === 'approved' ? `<button class="btn sm ghost" data-susp="${r.reported_id}" style="width:100%;color:var(--red)">${icon('block')}إيقاف السواق</button>` : ''}
            </div>` : ''}</div>`;
        }).join('');
        $$('[data-rs]').forEach(b => b.onclick = () => {
          const [id, st] = b.dataset.rs.split(':');
          if (st === 'reviewing') return setSt(id, st, null);
          modal(`<h2 style="margin:0;font-size:20px">${st === 'resolved' ? 'قفل البلاغ' : 'رفض البلاغ'}</h2>
            <div class="field"><label for="an">رد للمبلّغ (اختياري — بيظهر ليه في «بلاغاتي»)</label><textarea class="input" id="an" rows="3" style="height:auto;padding:12px 16px"></textarea></div>
            <button class="btn" id="anOk">حفظ</button>`, (o, close) => {
            $('#anOk', o).onclick = async () => { await setSt(id, st, $('#an', o).value.trim() || null); close(); };
          });
        });
        $$('[data-susp]').forEach(b => b.onclick = async () => {
          if (!(await confirmBox('إيقاف السواق؟', 'ما بيقدر يستلم مشاوير لحدي ما ترجعه من تبويب السواقين.', 'إيقاف', true))) return;
          const ok = await safe(async () => { const { error } = await sb.from('drivers').update({ status: 'suspended', is_online: false }).eq('id', b.dataset.susp); if (error) throw error; return true; }, 'السواق اتوقف');
          if (ok) load();
        });
      };
      const setSt = async (id, st, note) => {
        const patch = { status: st }; if (note) patch.admin_note = note; if (st !== 'reviewing') patch.resolved_at = new Date().toISOString();
        await safe(async () => { const { error } = await sb.from('reports').update(patch).eq('id', id); if (error) throw error; return true; }, 'اتحفظ');
        load();
      };
      await load();
      channel('adm-rp').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reports' }, () => { haptic(); toast('بلاغ جديد'); load(); }).subscribe();
    }

    if (tab === 'drivers') {
      const { data: ds } = await sb.from('drivers').select('*').order('created_at', { ascending: false });
      const list = ds || [];
      if (!list.length) { box.innerHTML = `<div class="empty">${icon('badge')}<b>ما في سواقين مسجلين لسه</b></div>`; return; }
      const ids = list.map(d => d.id);
      const [{ data: ps }, { data: docs }] = await Promise.all([
        sb.from('profiles').select('id,full_name,phone').in('id', ids),
        sb.from('driver_documents').select('*').in('driver_id', ids)
      ]);
      const pm = {}; (ps || []).forEach(p => pm[p.id] = p);
      const order = { pending: 0, approved: 1, suspended: 2, rejected: 3 };
      list.sort((a, b) => order[a.status] - order[b.status]);
      const urls = {};
      await Promise.all((docs || []).map(async d => { urls[d.id] = await signed('driver-docs', d.file_path); }));
      const ST = { pending: ['yellow', 'قيد المراجعة'], approved: ['green', 'مقبول'], rejected: ['red', 'مرفوض'], suspended: ['red', 'موقوف'] };
      box.innerHTML = list.map(d => {
        const p = pm[d.id] || {}, dd = (docs || []).filter(x => x.driver_id === d.id);
        return `<div class="card col gap12">
          <div class="row gap8"><div class="avatar grey">${initial(p.full_name)}</div>
            <div class="col grow"><b>${esc(p.full_name || '')}</b><a class="small muted" href="tel:${esc(p.phone || '')}" style="direction:ltr;text-align:right">${esc(p.phone || '')}</a></div>
            <span class="pill ${ST[d.status][0]}">${ST[d.status][1]}</span></div>
          <span class="small muted">لوحة ${esc(d.plate_number || '—')} · ${esc(d.vehicle_color || '')}${d.bankak_account ? ' · بنكك ' + esc(d.bankak_account) : ''}</span>
          <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px">${['photo', 'license', 'vehicle_registration', 'vehicle_photo'].map(k => {
            const doc = dd.find(x => x.type === k);
            return doc && urls[doc.id]
              ? `<a href="${urls[doc.id]}" style="text-decoration:none;color:inherit" class="col gap4"><img src="${urls[doc.id]}" alt="${DOCN[k]}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;background:#eee"><span class="small" style="text-align:center">${DOCN[k]}</span></a>`
              : `<div class="col gap4"><div style="aspect-ratio:1;border-radius:10px;border:2px dashed #C9D1CC;display:flex;align-items:center;justify-content:center">${icon('hide_image', '', 'color:#B8C0BB')}</div><span class="small muted" style="text-align:center">${DOCN[k]}</span></div>`;
          }).join('')}</div>
          <div class="row gap8">
            ${d.status !== 'approved' ? `<button class="btn sm" data-set="${d.id}:approved">${icon('check')}قبول</button>` : ''}
            ${d.status === 'pending' ? `<button class="btn sm ghost" data-set="${d.id}:rejected" style="color:var(--red)">رفض</button>` : ''}
            ${d.status === 'approved' ? `<button class="btn sm ghost" data-set="${d.id}:suspended" style="color:var(--red)">${icon('block')}إيقاف</button>` : ''}
          </div></div>`;
      }).join('');
      $$('[data-set]').forEach(b => b.onclick = async () => {
        const [id, st] = b.dataset.set.split(':');
        if (st !== 'approved' && !(await confirmBox('متأكد؟', st === 'rejected' ? 'السواق ده ما حيقدر يستلم مشاوير.' : 'السواق بيتوقف من استلام المشاوير.', 'تأكيد', true))) return;
        const patch = { status: st }; if (st !== 'approved') patch.is_online = false;
        const ok = await safe(async () => {
          const { error } = await sb.from('drivers').update(patch).eq('id', id); if (error) throw error;
          if (st === 'approved') await sb.from('driver_documents').update({ verified: true }).eq('driver_id', id);
          return true;
        }, st === 'approved' ? 'السواق اتقبل' : 'اتحفظ');
        if (ok) go('admin', { tab }, { replace: true });
      });
    }

    if (tab === 'subs') {
      const { data: ss } = await sb.from('subscriptions').select('*').order('created_at', { ascending: false }).limit(50);
      const list = ss || [];
      if (!list.length) { box.innerHTML = `<div class="empty">${icon('workspace_premium')}<b>ما في طلبات اشتراك</b></div>`; return; }
      const { data: ps } = await sb.from('profiles').select('id,full_name,phone').in('id', [...new Set(list.map(s => s.driver_id))]);
      const pm = {}; (ps || []).forEach(p => pm[p.id] = p);
      const urls = {}; await Promise.all(list.filter(s => s.receipt_path).map(async s => { urls[s.id] = await signed('receipts', s.receipt_path); }));
      const ST = { pending: ['yellow', 'منتظر'], active: ['green', 'فعّال'], rejected: ['red', 'مرفوض'], expired: ['grey', 'منتهي'] };
      box.innerHTML = list.map(s => {
        const p = pm[s.driver_id] || {};
        return `<div class="card col gap8">
          <div class="row gap8"><div class="col grow"><b>${esc(p.full_name || '')}</b><span class="small muted">${new Date(s.created_at).toLocaleString('ar-EG')}</span></div>
            <b>${money(s.amount)}</b><span class="pill ${ST[s.status][0]}">${ST[s.status][1]}</span></div>
          <span class="small">رقم العملية: <b>${esc(s.bankak_ref || '—')}</b>${s.ends_at ? ` · ينتهي ${new Date(s.ends_at).toLocaleDateString('ar-EG')}` : ''}</span>
          ${urls[s.id] ? `<a href="${urls[s.id]}"><img src="${urls[s.id]}" alt="الإشعار" style="width:100%;max-height:220px;object-fit:contain;border-radius:12px;background:#F4F6F5"></a>` : ''}
          ${s.status === 'pending' ? `<div class="row gap8"><button class="btn sm" data-act="${s.id}">${icon('check')}تفعيل ٣٠ يوم</button><button class="btn sm ghost" data-rej="${s.id}" style="color:var(--red)">رفض</button></div>` : ''}
        </div>`;
      }).join('');
      $$('[data-act]').forEach(b => b.onclick = async () => {
        const now = new Date(), end = new Date(now.getTime() + 30 * 86400000);
        const ok = await safe(async () => { const { error } = await sb.from('subscriptions').update({ status: 'active', starts_at: now.toISOString(), ends_at: end.toISOString() }).eq('id', b.dataset.act); if (error) throw error; return true; }, 'الاشتراك اتفعّل');
        if (ok) go('admin', { tab }, { replace: true });
      });
      $$('[data-rej]').forEach(b => b.onclick = async () => {
        const ok = await safe(async () => { const { error } = await sb.from('subscriptions').update({ status: 'rejected' }).eq('id', b.dataset.rej); if (error) throw error; return true; }, 'اترفض');
        if (ok) go('admin', { tab }, { replace: true });
      });
    }

    if (tab === 'stats') {
      const since = new Date(); since.setHours(0, 0, 0, 0);
      const cnt = async (q) => (await q).count || 0;
      const [users, drivers, online, today, done, active] = await Promise.all([
        cnt(sb.from('profiles').select('id', { count: 'exact', head: true })),
        cnt(sb.from('drivers').select('id', { count: 'exact', head: true }).eq('status', 'approved')),
        cnt(sb.from('drivers').select('id', { count: 'exact', head: true }).eq('is_online', true)),
        cnt(sb.from('trips').select('id', { count: 'exact', head: true }).gte('created_at', since.toISOString())),
        cnt(sb.from('trips').select('id', { count: 'exact', head: true }).eq('status', 'completed').gte('created_at', since.toISOString())),
        cnt(sb.from('trips').select('id', { count: 'exact', head: true }).in('status', ['accepted', 'arriving', 'arrived', 'in_progress']))
      ]);
      const tile = (ic, v, l, c = '') => `<div class="stat">${icon(ic, '', `font-size:22px;${c}`)}<b>${num(v)}</b><span class="small muted">${l}</span></div>`;
      box.innerHTML = `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">
        ${tile('group', users, 'مستخدم')}${tile('badge', drivers, 'سواق مقبول', 'color:var(--green)')}
        ${tile('wifi_tethering', online, 'سواق متاح هسع', 'color:var(--green)')}${tile('electric_rickshaw', active, 'مشوار شغال هسع')}
        ${tile('today', today, 'طلب اليوم', 'color:var(--blue)')}${tile('task_alt', done, 'مشوار اكتمل اليوم', 'color:var(--green)')}</div>`;
    }

    if (tab === 'settings') {
      const st = S.settings || {};
      const f = (k, l, type = 'number') => `<div class="field"><label for="s_${k}">${l}</label><input class="input" id="s_${k}" type="${type}" value="${esc(st[k] ?? '')}"></div>`;
      box.innerHTML = `<div class="card col gap12">
        <b>الأسعار</b>${f('base_fare', 'الأجرة الأساسية (جنيه)')}${f('per_km', 'سعر الكيلو (جنيه)')}</div>
        <div class="card col gap12"><b>الطرحة</b>${f('shared_capacity', 'عدد المقاعد في الركشة')}${f('shared_extra_pct', 'زيادة السواق لكل مجموعة إضافية (٪)')}</div>
        <div class="card col gap12"><b>الاشتراك</b>
          <label class="row gap8" style="justify-content:space-between"><span>إلزام السواقين بالاشتراك</span><input type="checkbox" id="s_req" ${st.require_subscription ? 'checked' : ''} style="width:24px;height:24px"></label>
          ${f('subscription_price', 'سعر الاشتراك الشهري')}${f('bankak_account', 'رقم حساب بنكك', 'text')}${f('bankak_name', 'اسم صاحب الحساب', 'text')}</div>
        <button class="btn" id="saveSt">حفظ الإعدادات</button>`;
      $('#saveSt').onclick = async () => {
        const v = (k) => $('#s_' + k).value.trim();
        const patch = { shared_capacity: Math.min(6, Math.max(2, +v('shared_capacity') || 4)), shared_extra_pct: Math.max(0, +v('shared_extra_pct') || 0), base_fare: +v('base_fare') || 0, per_km: +v('per_km') || 0, subscription_price: +v('subscription_price') || 0, bankak_account: v('bankak_account'), bankak_name: v('bankak_name'), require_subscription: $('#s_req').checked };
        const ok = await safe(async () => { const { error } = await sb.from('app_settings').update(patch).eq('id', 1); if (error) throw error; return true; }, 'اتحفظت الإعدادات');
        if (ok) Object.assign(S.settings, patch);
      };
    }
  }
});

/* =====================================================
   Boot
   ===================================================== */
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return go('auth', {}, { root: true });
  await loadMe();
  if (!S.profile) { await sleep(800); await loadMe(); }
  await routeToActive();
}

function setupNative() {
  if (!isNative) return;
  try { if (P.StatusBar) { P.StatusBar.setStyle({ style: 'DARK' }); P.StatusBar.setBackgroundColor({ color: '#0F1A14' }); } } catch (_) {}
  try { P.SplashScreen && P.SplashScreen.hide(); } catch (_) {}
  P.App && P.App.addListener('backButton', () => {
    const ov = $('.overlay'); if (ov) return ov.remove();
    if (!back()) P.App.exitApp();
  });
  P.App && P.App.addListener('appStateChange', ({ isActive }) => {
    // نحدّث بس الشاشات اللحظية؛ شاشات النماذج ما نلمسها (فتح الكاميرا/المعرض بيخلي التطبيق في الخلفية)
    const LIVE = ['waiting', 'tracking', 'driverTrip', 'driverHome', 'chat', 'support'];
    if (isActive && S.user && S.current && LIVE.includes(S.current.screen) && !$('.overlay')) {
      const c = S.current; go(c.screen, c.params, { replace: true });
    }
  });
  P.Network && P.Network.addListener('networkStatusChange', (s) => { if (!s.connected) toast('ما في اتصال بالإنترنت', 'error'); });
}

sb.auth.onAuthStateChange((ev) => {
  if (ev === 'SIGNED_OUT') { S.user = null; Loc.stop(); }
});

// كل النماذج بتتعالج بالجافاسكربت — ما نخلي أي نموذج يعيد تحميل التطبيق
document.addEventListener('submit', (e) => e.preventDefault(), true);
go('splash');
setupNative();
boot().catch((e) => { console.error(e); toast(errMsg(e), 'error'); go('auth', {}, { root: true }); });

})();
