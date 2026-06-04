const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Panel principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mac-panel.html'));
});

app.get('/mac-panel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mac-panel.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('FenixTV Panel corriendo en puerto ' + PORT);
});

// Proxy for Xtream API calls (bypasses CORS from browser)
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url param' });
  try {
    const https = require('https');
    const http = require('http');
    const lib = targetUrl.startsWith('https') ? https : http;
    lib.get(targetUrl, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try { res.json(JSON.parse(data)); }
        catch(e) { res.send(data); }
      });
    }).on('error', (e) => res.status(500).json({ error: e.message }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
