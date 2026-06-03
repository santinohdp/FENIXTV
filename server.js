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
