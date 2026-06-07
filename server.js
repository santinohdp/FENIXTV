const express = require('express');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');
const http    = require('http');

// ── Firebase Admin ────────────────────────────────────────
const admin = require('firebase-admin');

// Inicializa Firebase usando variables de entorno (Railway)
// o con credenciales embebidas como fallback
let db;
try {
  if (!admin.apps.length) {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      : null;

    if (serviceAccount) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL || 'https://helio-santino-rp-default-rtdb.firebaseio.com',
      });
    } else {
      // Sin credenciales de admin, usamos fetch directo a la REST API de Firebase
      admin.initializeApp({ databaseURL: 'https://helio-santino-rp-default-rtdb.firebaseio.com' });
    }
  }
  db = admin.database();
} catch(e) {
  console.warn('Firebase Admin init warning:', e.message);
}

// Helper: leer un nodo de Firebase via REST (no requiere service account)
const FB_DB = 'https://helio-santino-rp-default-rtdb.firebaseio.com';

async function fbGet(nodePath) {
  return new Promise((resolve, reject) => {
    const url = `${FB_DB}/${nodePath}.json`;
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    }).on('error', e => reject(e));
  });
}

async function fbSet(nodePath, value) {
  return new Promise((resolve, reject) => {
    const url = `${FB_DB}/${nodePath}.json`;
    const body = JSON.stringify(value);
    const options = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const urlObj = new URL(url);
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request({ ...urlObj, ...options }, res => {
      let d = ''; res.on('data', c => d+=c); res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Helpers MAC ───────────────────────────────────────────
// Firebase guarda la MAC con '-' en lugar de ':'
function macToKey(mac) { return mac.toUpperCase().replace(/:/g, '-'); }
function keyToMac(key) { return key.replace(/-/g, ':'); }

// Genera token simple basado en MAC + timestamp
function generateToken(mac) {
  const ts = Math.floor(Date.now() / 1000);
  const raw = `${mac}-${ts}-FENIXTV`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).padStart(8, '0').toUpperCase() + ts.toString(16).toUpperCase();
}

// Cache de tokens en memoria: token -> { mac, expiresAt }
const tokenCache = new Map();

function storeToken(mac, token) {
  tokenCache.set(token, { mac, expiresAt: Date.now() + 3600000 }); // 1 hora
  // limpieza de tokens expirados
  for (const [k, v] of tokenCache) {
    if (v.expiresAt < Date.now()) tokenCache.delete(k);
  }
}

function getMacFromToken(token) {
  const entry = tokenCache.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { tokenCache.delete(token); return null; }
  return entry.mac;
}

function getMacFromRequest(req) {
  // Intenta obtener MAC desde el header Authorization: Bearer <token>
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const mac = getMacFromToken(token);
    if (mac) return mac;
  }
  // Fallback: cookie mac=XX:XX:XX
  const cookie = req.headers['cookie'] || '';
  const m = cookie.match(/mac=([0-9A-Fa-f:]{17})/);
  if (m) return m[1].toUpperCase();
  return null;
}

async function getDeviceByMac(mac) {
  const key = macToKey(mac);
  try {
    const data = await fbGet(`mac_index/${key}`);
    return data;
  } catch(e) {
    return null;
  }
}

// ── Express ───────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Panel principal
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mac-panel.html')));
app.get('/mac-panel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mac-panel.html')));
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), stalker: 'enabled' }));

// Proxy Xtream (existente)
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url param' });
  try {
    const lib = targetUrl.startsWith('https') ? https : http;
    lib.get(targetUrl, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try { res.json(JSON.parse(data)); } catch(e) { res.send(data); }
      });
    }).on('error', e => res.status(500).json({ error: e.message }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// STALKER / MINISTRA API — Compatible con OTT Navigator
// ═══════════════════════════════════════════════════════════
// OTT Navigator abre: /stalker_portal/c/ como URL del portal
// y hace requests a: /portal.php?type=stb&action=handshake
// con Cookie: mac=XX:XX:XX:XX:XX:XX

// Ruta del loader (OTT Navigator navega aquí primero)
app.get('/stalker_portal/c', (req, res) => res.send('OK'));
app.get('/stalker_portal/c/', (req, res) => res.send('OK'));

// ─── portal.php — router principal ───────────────────────
app.get('/portal.php', async (req, res) => {
  const { type, action } = req.query;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── STB: HANDSHAKE ─────────────────────────────────────
  if (type === 'stb' && action === 'handshake') {
    const cookie = req.headers['cookie'] || '';
    const macMatch = cookie.match(/mac=([0-9A-Fa-f:]{17})/i);
    const mac = macMatch ? macMatch[1].toUpperCase() : null;

    if (!mac) {
      return res.json({ js: { token: '', error: 'no mac in cookie' } });
    }

    // Registrar en pending_macs si no tiene lista asignada
    const device = await getDeviceByMac(mac);
    if (!device) {
      const key = macToKey(mac).replace(/:/g, '-');
      try {
        await fbSet(`pending_macs/${key}`, {
          mac,
          deviceId: mac,
          ts: Date.now(),
          source: 'OTT Navigator',
        });
      } catch(e) {}
    }

    const token = generateToken(mac);
    storeToken(mac, token);
    console.log(`[STALKER] Handshake MAC=${mac} token=${token}`);

    return res.json({
      js: {
        token,
        random: Math.random().toString(36).slice(2),
      }
    });
  }

  // ── STB: GET PROFILE ───────────────────────────────────
  if (type === 'stb' && action === 'get_profile') {
    const mac = getMacFromRequest(req);
    if (!mac) return res.json({ js: { error: 'no auth: no handshake' } });

    const device = await getDeviceByMac(mac);
    const hasService = !!(device && device.url);
    const expiry = device?.expiry ? Math.floor(device.expiry / 1000) : 0;

    return res.json({
      js: {
        id: '1',
        name: device?.name || mac,
        status: hasService ? 'Active' : 'Inactive',
        exp_date: expiry ? String(expiry) : '0',
        is_trial: '0',
        active_cons: '1',
        max_connections: '1',
        created_at: String(Math.floor(Date.now() / 1000) - 86400),
        updated_at: String(Math.floor(Date.now() / 1000)),
        mac,
        fname: device?.name || '',
        login: mac,
        password: '',
        parentalPasswd: '0000',
        theme: 'default',
        play_token: '',
        additional_services_on: '0',
        default_lang: 'es',
        stb_lang: 'es',
        timezone: 'America/Argentina/Buenos_Aires',
        locale: 'es_ES',
        tariff_plan_id: '1',
        tariff_plan: 'Basic',
        keep_alive: '1',
        disabled: hasService ? '0' : '1',
        blocked: hasService ? '0' : '1',
        hotline_enabled: '0',
        phone: '',
        sname: 'FenixTV',
        mparent_id: '1',
        casystem_id: '0',
        force_ch_link_check: '0',
        fav_itv_on: '1',
        now_playing_start: '0',
        now_playing_type: '0',
        now_playing_content: '0',
        ip: req.ip || '',
        image_version: '218',
        stb_type: 'MAG250',
        hd: '1',
        main_notify: '0',
      }
    });
  }

  // ── ITV: GET GENRES (categorías de canales) ────────────
  if (type === 'itv' && action === 'get_genres') {
    const mac = getMacFromRequest(req);
    if (!mac) return res.json({ js: [] });

    return res.json({
      js: [
        { id: '*', title: 'Todos', alias: 'all', censored: '0' },
        { id: '1', title: 'General', alias: 'general', censored: '0' },
      ]
    });
  }

  // ── ITV: GET ALL CHANNELS ──────────────────────────────
  if (type === 'itv' && action === 'get_all_channels') {
    const mac = getMacFromRequest(req);
    if (!mac) return res.json({ js: { total_items: 0, max_page_items: 0, selected_item: 0, data: [] } });

    const device = await getDeviceByMac(mac);
    if (!device || !device.url) {
      return res.json({ js: { total_items: 0, max_page_items: 0, selected_item: 0, data: [] } });
    }

    // Si es Xtream, devolvemos los canales del proveedor como proxy
    if (device.listType === 'xtream' && device.xtreamServer && device.xtreamUser && device.xtreamPass) {
      try {
        const apiUrl = `${device.xtreamServer}/player_api.php?username=${device.xtreamUser}&password=${device.xtreamPass}&action=get_live_streams`;
        const data = await fetchExternal(apiUrl);
        const channels = Array.isArray(data) ? data.map((ch, i) => ({
          id: String(ch.stream_id || i+1),
          name: ch.name || `Canal ${i+1}`,
          number: String(i+1),
          cmd: `${device.xtreamServer}/live/${device.xtreamUser}/${device.xtreamPass}/${ch.stream_id}.m3u8`,
          genres_id: ch.category_id || '1',
          tv_genre_id: ch.category_id || '1',
          logo: ch.stream_icon || '',
          epg_id: '',
          censored: '0',
          allow_pvr: '0',
          hd: '1',
          xmltv_id: '',
          time_shift_on: '0',
        })) : [];
        return res.json({ js: { total_items: channels.length, max_page_items: channels.length, selected_item: 0, data: channels } });
      } catch(e) {
        console.error('[STALKER] Xtream fetch error:', e.message);
        return res.json({ js: { total_items: 0, max_page_items: 0, selected_item: 0, data: [] } });
      }
    }

    // M3U: devolvemos un canal genérico que apunta a la URL del cliente
    const channels = [{
      id: '1',
      name: device.name || 'Lista',
      number: '1',
      cmd: device.url,
      genres_id: '1',
      tv_genre_id: '1',
      logo: '',
      epg_id: '',
      censored: '0',
      allow_pvr: '0',
      hd: '1',
      xmltv_id: '',
      time_shift_on: '0',
    }];
    return res.json({ js: { total_items: 1, max_page_items: 1, selected_item: 0, data: channels } });
  }

  // ── ITV: CREATE LINK (obtener URL de stream) ───────────
  if (type === 'itv' && action === 'create_link') {
    const mac = getMacFromRequest(req);
    if (!mac) return res.json({ js: { cmd: '', error: 'no auth' } });

    const device = await getDeviceByMac(mac);
    if (!device || !device.url) {
      return res.json({ js: { cmd: '', error: 'no list' } });
    }

    const cmd = req.query.cmd || '';
    // Si el cmd ya es una URL completa la devolvemos directamente
    let streamUrl = cmd.startsWith('http') ? cmd : device.url;

    return res.json({ js: { cmd: `ffmpeg ${streamUrl}`, id: '1' } });
  }

  // ── VOD: GET CATEGORIES ────────────────────────────────
  if (type === 'vod' && action === 'get_categories') {
    return res.json({ js: [] });
  }

  // ── VOD: GET ORDERED LIST ──────────────────────────────
  if (type === 'vod' && action === 'get_ordered_list') {
    return res.json({ js: { total_items: 0, max_page_items: 0, selected_item: 0, data: [] } });
  }

  // ── SERIES ─────────────────────────────────────────────
  if (type === 'series' && (action === 'get_categories' || action === 'get_ordered_list')) {
    return res.json({ js: { total_items: 0, max_page_items: 0, selected_item: 0, data: [] } });
  }

  // ── STB: GET ALL FAV_ITV ───────────────────────────────
  if (action === 'get_all_fav_itv') {
    return res.json({ js: [] });
  }

  // Fallback
  return res.json({ js: {} });
});

// También acepta POST (algunos clientes lo usan)
app.post('/portal.php', (req, res) => {
  // Reenviar como GET
  req.query = { ...req.body, ...req.query };
  app._router.handle(Object.assign(req, { method: 'GET' }), res, () => {});
});

// ── Helper fetch externo ──────────────────────────────────
function fetchExternal(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    }).on('error', reject);
  });
}

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FenixTV Panel corriendo en puerto ${PORT}`);
  console.log(`Stalker API activa en /portal.php`);
  console.log(`Portal URL para OTT Navigator: https://streamflix-production-9559.up.railway.app/stalker_portal/c/`);
});
