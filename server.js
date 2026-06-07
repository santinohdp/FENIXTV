const express = require('express');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');
const http    = require('http');

// ── Firebase Admin ────────────────────────────────────────
const admin = require('firebase-admin');

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
      admin.initializeApp({ databaseURL: 'https://helio-santino-rp-default-rtdb.firebaseio.com' });
    }
  }
  db = admin.database();
} catch(e) {
  console.warn('Firebase Admin init warning:', e.message);
}

// ── Firebase REST (no requiere service account) ───────────
const FB_DB = 'https://helio-santino-rp-default-rtdb.firebaseio.com';

async function fbGet(nodePath) {
  return new Promise((resolve, reject) => {
    const url = `${FB_DB}/${nodePath}.json`;
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    }).on('error', e => { console.error('fbGet error:', e.message); resolve(null); });
  });
}

async function fbSet(nodePath, value) {
  return new Promise((resolve) => {
    const body = JSON.stringify(value);
    const urlObj = new URL(`${FB_DB}/${nodePath}.json`);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(true));
    });
    req.on('error', e => { console.error('fbSet error:', e.message); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ── Helpers MAC ───────────────────────────────────────────
function macToKey(mac) {
  return mac.toUpperCase().replace(/:/g, '-');
}

function extractMac(str) {
  if (!str) return null;
  const m = String(str).match(/([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}/);
  if (m) return m[0].toUpperCase().replace(/-/g, ':');
  return null;
}

// ── Token cache ───────────────────────────────────────────
const tokenCache = new Map();

function generateToken(mac) {
  const ts = Math.floor(Date.now() / 1000);
  let h = 0;
  const raw = `${mac}-${ts}-FENIXTV`;
  for (let i = 0; i < raw.length; i++) h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).padStart(8,'0').toUpperCase() + ts.toString(16).toUpperCase();
}

function storeToken(mac, token) {
  tokenCache.set(token, { mac, expiresAt: Date.now() + 7200000 }); // 2 horas
  for (const [k, v] of tokenCache) {
    if (v.expiresAt < Date.now()) tokenCache.delete(k);
  }
}

function getMacFromToken(token) {
  const entry = tokenCache.get(token);
  if (!entry || entry.expiresAt < Date.now()) { tokenCache.delete(token); return null; }
  return entry.mac;
}

// ── Leer MAC de TODAS las fuentes posibles ────────────────
function getMacFromRequest(req) {
  // 1. Authorization: Bearer <token>
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    const mac = getMacFromToken(token);
    if (mac) return mac;
  }

  // 2. Cookie: mac=XX:XX:XX:XX:XX:XX
  const cookie = req.headers['cookie'] || '';
  const macFromCookie = extractMac(cookie);
  if (macFromCookie) return macFromCookie;

  // 3. Headers alternativos
  for (const h of ['x-real-mac','x-mac-address','x-stb-mac','mac','device-mac']) {
    const mac = extractMac(req.headers[h]);
    if (mac) return mac;
  }

  // 4. Query string ?mac=
  if (req.query.mac) {
    const mac = extractMac(req.query.mac);
    if (mac) return mac;
  }

  // 5. Body POST
  if (req.body && req.body.mac) {
    const mac = extractMac(req.body.mac);
    if (mac) return mac;
  }

  return null;
}

async function getDeviceByMac(mac) {
  const key = macToKey(mac);
  return await fbGet(`mac_index/${key}`);
}

// ── Express ───────────────────────────────────────────────
const app = express();

// Trust Railway proxy
app.set('trust proxy', true);

app.use(cors({
  origin: '*',
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['*'],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Paneles
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mac-panel.html')));
app.get('/mac-panel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mac-panel.html')));
app.get('/ott-panel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ott-panel.html')));

// Health check
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), stalker: 'enabled' }));

// Debug endpoint — muestra qué headers manda OTT Navigator
app.get('/debug-headers', (req, res) => {
  res.json({
    headers: req.headers,
    query: req.query,
    ip: req.ip,
  });
});

// Proxy Xtream
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
// STALKER API — Compatible OTT Navigator
// ═══════════════════════════════════════════════════════════

// Portal loader — OTT Navigator navega aquí primero
app.get('/stalker_portal/c', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<html><body>FenixTV Portal</body></html>');
});
app.get('/stalker_portal/c/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<html><body>FenixTV Portal</body></html>');
});

// Acepta OPTIONS para CORS preflight
app.options('/portal.php', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.status(200).end();
});

// Handler unificado para GET y POST
async function portalHandler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  const type   = req.query.type   || req.body?.type;
  const action = req.query.action || req.body?.action;

  console.log(`[PORTAL] ${req.method} type=${type} action=${action}`);
  console.log(`[PORTAL] Cookie: ${req.headers['cookie']}`);
  console.log(`[PORTAL] Auth: ${req.headers['authorization']}`);
  console.log(`[PORTAL] UA: ${req.headers['user-agent']}`);

  // ── HANDSHAKE ───────────────────────────────────────────
  if (type === 'stb' && action === 'handshake') {
    // Intentar leer MAC de todas las fuentes
    const cookie = req.headers['cookie'] || '';
    const mac =
      extractMac(cookie) ||
      extractMac(req.headers['x-real-mac']) ||
      extractMac(req.headers['x-mac-address']) ||
      extractMac(req.headers['mac']) ||
      extractMac(req.query.mac) ||
      extractMac(req.body?.mac);

    console.log(`[HANDSHAKE] MAC encontrada: ${mac}`);

    if (!mac) {
      console.log(`[HANDSHAKE] FALLO - headers completos: ${JSON.stringify(req.headers)}`);
      // Devolver token vacío pero no error, para que OTT Navigator siga intentando
      return res.json({ js: { token: 'NO_MAC', random: 'abc123' } });
    }

    // Registrar como pendiente si no tiene lista
    const device = await getDeviceByMac(mac);
    if (!device) {
      const key = macToKey(mac);
      await fbSet(`pending_macs/${key}`, {
        mac,
        deviceId: mac,
        ts: Date.now(),
        source: 'OTT Navigator',
      });
      console.log(`[HANDSHAKE] MAC nueva registrada en pending_macs: ${mac}`);
    } else {
      console.log(`[HANDSHAKE] MAC conocida: ${mac} (${device.name || 'sin nombre'})`);
    }

    const token = generateToken(mac);
    storeToken(mac, token);
    console.log(`[HANDSHAKE] OK MAC=${mac} token=${token}`);

    return res.json({
      js: {
        token,
        random: Math.random().toString(36).slice(2, 10),
      }
    });
  }

  // ── GET PROFILE ─────────────────────────────────────────
  if (type === 'stb' && action === 'get_profile') {
    const mac = getMacFromRequest(req);
    console.log(`[GET_PROFILE] MAC=${mac}`);
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
        disabled: '0',
        blocked: '0',
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
        operator_name: 'FenixTV',
        service_introduction: '0',
        show_tv_only_by_name: '0',
        restricted_search: '0',
      }
    });
  }

  // ── GET GENRES / CATEGORÍAS ─────────────────────────────
  if (type === 'itv' && action === 'get_genres') {
    return res.json({
      js: [
        { id: '*', title: 'Todos', alias: 'all', censored: '0' },
        { id: '1', title: 'General', alias: 'general', censored: '0' },
        { id: '2', title: 'Deportes', alias: 'sports', censored: '0' },
        { id: '3', title: 'Noticias', alias: 'news', censored: '0' },
      ]
    });
  }

  // ── GET ALL CHANNELS ─────────────────────────────────────
  if (type === 'itv' && action === 'get_all_channels') {
    const mac = getMacFromRequest(req);
    console.log(`[GET_CHANNELS] MAC=${mac}`);
    if (!mac) return res.json({ js: { total_items: 0, max_page_items: 0, selected_item: 0, data: [] } });

    const device = await getDeviceByMac(mac);
    if (!device || !device.url) {
      console.log(`[GET_CHANNELS] Sin lista para MAC=${mac}`);
      return res.json({ js: { total_items: 0, max_page_items: 0, selected_item: 0, data: [] } });
    }

    // Xtream: traer canales del proveedor
    if (device.listType === 'xtream' && device.xtreamServer && device.xtreamUser && device.xtreamPass) {
      try {
        const apiUrl = `${device.xtreamServer}/player_api.php?username=${device.xtreamUser}&password=${device.xtreamPass}&action=get_live_streams`;
        const data = await fetchExternal(apiUrl);
        if (Array.isArray(data)) {
          const channels = data.map((ch, i) => ({
            id: String(ch.stream_id || i + 1),
            name: ch.name || `Canal ${i + 1}`,
            number: String(i + 1),
            cmd: `ffmpeg ${device.xtreamServer}/live/${device.xtreamUser}/${device.xtreamPass}/${ch.stream_id}.m3u8`,
            genres_id: String(ch.category_id || '1'),
            tv_genre_id: String(ch.category_id || '1'),
            logo: ch.stream_icon || '',
            epg_id: '',
            censored: '0',
            allow_pvr: '0',
            hd: '1',
            xmltv_id: '',
            time_shift_on: '0',
            use_http_tmp_link: '0',
            aspect: '16:9',
          }));
          return res.json({ js: { total_items: channels.length, max_page_items: channels.length, selected_item: 0, data: channels } });
        }
      } catch(e) {
        console.error('[GET_CHANNELS] Xtream error:', e.message);
      }
    }

    // M3U: canal único que apunta a la URL
    const channel = {
      id: '1',
      name: device.name || 'Mi Lista',
      number: '1',
      cmd: `ffmpeg ${device.url}`,
      genres_id: '1',
      tv_genre_id: '1',
      logo: '',
      epg_id: '',
      censored: '0',
      allow_pvr: '0',
      hd: '1',
      xmltv_id: '',
      time_shift_on: '0',
      use_http_tmp_link: '0',
      aspect: '16:9',
    };
    return res.json({ js: { total_items: 1, max_page_items: 1, selected_item: 0, data: [channel] } });
  }

  // ── CREATE LINK ──────────────────────────────────────────
  if (type === 'itv' && action === 'create_link') {
    const mac = getMacFromRequest(req);
    if (!mac) return res.json({ js: { cmd: '', error: 'no auth' } });

    const device = await getDeviceByMac(mac);
    if (!device || !device.url) return res.json({ js: { cmd: '', error: 'no list' } });

    const cmd = req.query.cmd || req.body?.cmd || '';
    // Si cmd es una URL completa la usamos, si no usamos la URL del dispositivo
    let streamUrl = cmd.startsWith('ffmpeg ') ? cmd.replace('ffmpeg ', '') : (cmd.startsWith('http') ? cmd : device.url);
    console.log(`[CREATE_LINK] MAC=${mac} url=${streamUrl}`);

    return res.json({ js: { cmd: `ffmpeg ${streamUrl}`, id: '1' } });
  }

  // ── VOD ──────────────────────────────────────────────────
  if (type === 'vod') {
    if (action === 'get_categories') return res.json({ js: [] });
    if (action === 'get_ordered_list') return res.json({ js: { total_items: 0, max_page_items: 0, selected_item: 0, data: [] } });
    return res.json({ js: [] });
  }

  // ── SERIES ───────────────────────────────────────────────
  if (type === 'series') {
    return res.json({ js: { total_items: 0, max_page_items: 0, selected_item: 0, data: [] } });
  }

  // ── FAVORITOS ────────────────────────────────────────────
  if (action === 'get_all_fav_itv' || action === 'get_fav_itv') {
    return res.json({ js: [] });
  }

  // ── EPG ──────────────────────────────────────────────────
  if (type === 'epg' || action === 'get_simple_data_table' || action === 'get_epg_info') {
    return res.json({ js: { data: [] } });
  }

  // Fallback
  console.log(`[PORTAL] No handler for type=${type} action=${action}`);
  return res.json({ js: {} });
}

app.get('/portal.php', portalHandler);
app.post('/portal.php', portalHandler);

// ── Helper fetch externo ──────────────────────────────────
function fetchExternal(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { timeout: 8000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FenixTV Panel corriendo en puerto ${PORT}`);
  console.log(`Stalker API: /portal.php`);
  console.log(`Debug headers: /debug-headers`);
  console.log(`Portal OTT: /stalker_portal/c/`);
});
