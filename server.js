const express = require('express');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const crypto  = require('crypto');

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

async function fbDelete(nodePath) {
  return new Promise((resolve) => {
    const urlObj = new URL(`${FB_DB}/${nodePath}.json`);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'DELETE',
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

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

// ── Express ───────────────────────────────────────────────
const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['*'], credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Paneles ───────────────────────────────────────────────
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'panel.html')));
app.get('/panel',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'panel.html')));
app.get('/mac-panel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'panel.html')));

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Proxy para detectar expiry desde el panel ─────────────
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

// ══════════════════════════════════════════════════════════
// API DE USUARIOS — Panel CRUD
// ══════════════════════════════════════════════════════════

// GET /api/users — listar todos
app.get('/api/users', async (req, res) => {
  const data = await fbGet('iptv_users') || {};
  res.json(data);
});

// POST /api/users — crear usuario
app.post('/api/users', async (req, res) => {
  const { username, password, listType, url, xtreamServer, xtreamUser, xtreamPass, expiry, name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username y password requeridos' });

  const existing = await fbGet(`iptv_users/${username}`);
  if (existing) return res.status(409).json({ error: 'Usuario ya existe' });

  const payload = {
    username,
    password,
    name: name || username,
    listType: listType || 'm3u',
    createdAt: Date.now(),
    active: true,
  };
  if (expiry) payload.expiry = new Date(expiry).getTime();
  if (listType === 'xtream') {
    payload.xtreamServer = xtreamServer;
    payload.xtreamUser   = xtreamUser;
    payload.xtreamPass   = xtreamPass;
    payload.url = `${xtreamServer}/get.php?username=${xtreamUser}&password=${xtreamPass}&type=m3u_plus`;
  } else {
    payload.url = url;
  }

  await fbSet(`iptv_users/${username}`, payload);
  res.json({ ok: true, user: payload });
});

// PUT /api/users/:username — editar
app.put('/api/users/:username', async (req, res) => {
  const { username } = req.params;
  const existing = await fbGet(`iptv_users/${username}`);
  if (!existing) return res.status(404).json({ error: 'No existe' });

  const { password, listType, url, xtreamServer, xtreamUser, xtreamPass, expiry, name, active } = req.body;
  const payload = { ...existing };
  if (password)   payload.password   = password;
  if (name)       payload.name       = name;
  if (active !== undefined) payload.active = active;
  if (expiry)     payload.expiry     = new Date(expiry).getTime();
  if (listType) {
    payload.listType = listType;
    if (listType === 'xtream') {
      payload.xtreamServer = xtreamServer || existing.xtreamServer;
      payload.xtreamUser   = xtreamUser   || existing.xtreamUser;
      payload.xtreamPass   = xtreamPass   || existing.xtreamPass;
      payload.url = `${payload.xtreamServer}/get.php?username=${payload.xtreamUser}&password=${payload.xtreamPass}&type=m3u_plus`;
    } else {
      payload.url = url || existing.url;
    }
  } else if (url) {
    payload.url = url;
  }
  payload.updatedAt = Date.now();

  await fbSet(`iptv_users/${username}`, payload);
  res.json({ ok: true, user: payload });
});

// DELETE /api/users/:username
app.delete('/api/users/:username', async (req, res) => {
  await fbDelete(`iptv_users/${req.params.username}`);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
// XTREAM CODES API — Lo que la app usa para conectarse
// ══════════════════════════════════════════════════════════
// La app pone:
//   Servidor: https://tu-railway.app
//   Usuario: el username creado en el panel
//   Contraseña: el password del usuario
//
// Endpoints que IPTV Smarters usa:
//   GET /player_api.php?username=X&password=Y&action=get_live_streams
//   GET /get.php?username=X&password=Y&type=m3u_plus
//   GET /xmltv.php?username=X&password=Y (EPG, opcional)

async function getUser(username, password) {
  const user = await fbGet(`iptv_users/${username}`);
  if (!user) return null;
  if (user.password !== password) return null;
  if (!user.active) return null;
  if (user.expiry && user.expiry < Date.now()) return null;
  return user;
}

// player_api.php — endpoint principal de Xtream
app.get('/player_api.php', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { username, password, action } = req.query;

  const user = await getUser(username, password);
  if (!user) {
    return res.json({ user_info: { auth: 0 }, server_info: {} });
  }

  const expDate = user.expiry ? Math.floor(user.expiry / 1000) : 0;
  const userInfo = {
    auth: 1,
    username,
    password,
    message: '',
    exp_date: expDate ? String(expDate) : '0',
    is_trial: '0',
    active_cons: '1',
    created_at: String(Math.floor((user.createdAt || Date.now()) / 1000)),
    max_connections: '1',
    allowed_output_formats: ['m3u8', 'ts', 'rtmp'],
    status: 'Active',
  };

  const serverInfo = {
    url: req.hostname,
    port: '80',
    https_port: '443',
    server_protocol: 'https',
    rtmp_port: '1935',
    timezone: 'America/Argentina/Buenos_Aires',
    timestamp_now: Math.floor(Date.now() / 1000),
    time_now: new Date().toISOString(),
  };

  // Sin action = info del usuario (lo que pide la app al hacer login)
  if (!action) {
    return res.json({ user_info: userInfo, server_info: serverInfo });
  }

  // ── Si el usuario tiene Xtream propio, hacer proxy ───────
  if (user.listType === 'xtream' && user.xtreamServer) {
    const proxyUrl = `${user.xtreamServer}/player_api.php?username=${user.xtreamUser}&password=${user.xtreamPass}&action=${action}${req.query.category_id ? '&category_id='+req.query.category_id : ''}${req.query.stream_id ? '&stream_id='+req.query.stream_id : ''}`;
    try {
      const data = await fetchExternal(proxyUrl);
      if (data) return res.json(data);
    } catch(e) {}
  }

  // ── Si tiene URL M3U — respuestas básicas ────────────────
  if (action === 'get_live_categories') return res.json([{ category_id: '1', category_name: 'Lista IPTV', parent_id: 0 }]);
  if (action === 'get_live_streams') {
    return res.json([{
      num: 1, name: 'Lista IPTV', stream_type: 'live',
      stream_id: 1, stream_icon: '',
      epg_channel_id: '', added: '', category_id: '1',
      custom_sid: '', tv_archive: 0, direct_source: user.url || '',
      tv_archive_duration: 0,
    }]);
  }
  if (action === 'get_vod_categories')    return res.json([]);
  if (action === 'get_vod_streams')       return res.json([]);
  if (action === 'get_series_categories') return res.json([]);
  if (action === 'get_series')            return res.json([]);

  return res.json({ user_info: userInfo, server_info: serverInfo });
});

// get.php — devuelve M3U directamente
app.get('/get.php', async (req, res) => {
  const { username, password, type } = req.query;
  const user = await getUser(username, password);
  if (!user) return res.status(401).send('#EXTM3U\n# Auth failed');

  if (!user.url) return res.status(404).send('#EXTM3U\n# No list assigned');

  // Si tiene Xtream propio, redirigir al M3U del proveedor
  if (user.listType === 'xtream' && user.xtreamServer) {
    const m3uUrl = `${user.xtreamServer}/get.php?username=${user.xtreamUser}&password=${user.xtreamPass}&type=${type||'m3u_plus'}`;
    return res.redirect(302, m3uUrl);
  }

  // Si tiene URL M3U directa, redirigir
  return res.redirect(302, user.url);
});

// xmltv.php — EPG (redirigir o vacío)
app.get('/xmltv.php', async (req, res) => {
  const { username, password } = req.query;
  const user = await getUser(username, password);
  if (!user) return res.status(401).send('');
  if (user.listType === 'xtream' && user.xtreamServer) {
    return res.redirect(302, `${user.xtreamServer}/xmltv.php?username=${user.xtreamUser}&password=${user.xtreamPass}`);
  }
  res.setHeader('Content-Type', 'application/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Panel IPTV corriendo en puerto ${PORT}`);
  console.log(`Xtream API: /player_api.php`);
  console.log(`M3U: /get.php`);
});
