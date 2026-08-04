// bridge.js
//
// Agrega las rutas que necesita la app Android "TV" (com.tv.tv, la que antes
// hablaba con api.pluscapelian.com). El APK ya fue parcheado para apuntar acá.
//
// Se monta en tu server.js pasándole las piezas que ya tenés (fbGet,
// getUser, fetchExternal) — no duplica nada, no toca tu Firebase ni tu lógica
// de usuarios existente.
//
// Uso en server.js (agregar antes de app.listen):
//
//   const createBridge = require('./bridge');
//   app.use(createBridge({ fbGet, getUser, fetchExternal, publicBaseUrl: 'https://fenixtv-1.onrender.com' }));

const express = require("express");
const { deriveKeyIv, encryptAES, keyIvToBase64 } = require("./crypto");
const {
  buildLiveCategories,
  buildVodCategories,
  buildSeriesCategories,
} = require("./translator");

module.exports = function createBridge({ fbGet, getUser, fetchExternal, publicBaseUrl }) {
  const router = express.Router();

  // Solo cuentas Xtream tienen categorías/streams — con M3U no hay forma de
  // armar el listado que esta app necesita.
  async function xtreamAction(username, password, action, extra = {}) {
    const user = await getUser(username, password);
    if (!user || user.listType !== "xtream" || !user.xtreamServer) return [];
    const qs = Object.entries(extra)
      .map(([k, v]) => `&${k}=${encodeURIComponent(v)}`)
      .join("");
    const proxyUrl = `${user.xtreamServer}/player_api.php?username=${user.xtreamUser}&password=${user.xtreamPass}&action=${action}${qs}`;
    try {
      const data = await fetchExternal(proxyUrl);
      return Array.isArray(data) ? data : data || [];
    } catch (e) {
      console.error(`[bridge] xtreamAction(${action}) error:`, e.message);
      return [];
    }
  }

  function groupByCategory(streams) {
    const grouped = {};
    for (const s of streams) {
      const cid = s.category_id;
      if (!grouped[cid]) grouped[cid] = [];
      grouped[cid].push(s);
    }
    return grouped;
  }

  // ------------------------------------------------------------------
  // Login
  // ------------------------------------------------------------------
  router.post("/apis-protect/validarusuario_2.php", async (req, res) => {
    const usuario = req.body.usuario || req.body.user || "";
    const password = req.body.password || "";

    if (!usuario || !password) {
      return res.json({ response: { message: "credenciales_invalidas" } });
    }

    try {
      const user = await fbGet(`iptv_users/${usuario}`);
      console.log(`[bridge] login intento usuario="${usuario}" -> encontrado en Firebase:`, !!user);

      if (!user) {
        console.log(`[bridge] rechazado: no existe "iptv_users/${usuario}" en Firebase`);
        return res.json({ response: { message: "credenciales_invalidas" } });
      }
      if (user.password !== password) {
        console.log(`[bridge] rechazado: password no coincide (esperado="${user.password}", recibido="${password}")`);
        return res.json({ response: { message: "credenciales_invalidas" } });
      }
      if (user.listType !== "xtream" || !user.xtreamServer) {
        console.log(`[bridge] rechazado: listType="${user.listType}" (necesita ser "xtream" con xtreamServer cargado)`);
        return res.json({ response: { message: "credenciales_invalidas" } });
      }
      if (!user.active) {
        console.log(`[bridge] rechazado: usuario inactivo (active=${user.active})`);
        return res.json({ response: { message: "credenciales_invalidas" } });
      }
      if (user.expiry && user.expiry < Date.now()) {
        console.log(`[bridge] rechazado: usuario vencido (expiry=${new Date(user.expiry).toISOString()})`);
        return res.json({ response: { message: "usuario_vencido" } });
      }

      console.log(`[bridge] login OK para "${usuario}"`);

      const { key, iv } = deriveKeyIv(usuario, password);
      const { keyB64, ivB64 } = keyIvToBase64({ key, iv });

      const mk = (kind) =>
        `${publicBaseUrl}/apis-protect/content/${kind}?u=${encodeURIComponent(
          usuario
        )}&p=${encodeURIComponent(password)}`;

      return res.json({
        response: {
          message: "success_login",
          list: encryptAES(mk("live"), key, iv),
          movies: encryptAES(mk("movies"), key, iv),
          series: encryptAES(mk("series"), key, iv),
          anime: encryptAES(mk("anime"), key, iv),
          iv: keyB64,
          iv2: ivB64,
        },
      });
    } catch (err) {
      console.error("[bridge] login error:", err.message);
      return res.status(500).json({ response: { message: "error_servidor" } });
    }
  });

  // ------------------------------------------------------------------
  // Contenido
  // ------------------------------------------------------------------

  router.get("/apis-protect/content/live", async (req, res) => {
    const { u, p } = req.query;
    if (!u || !p) return res.json([]);
    try {
      const [categories, allStreams] = await Promise.all([
        xtreamAction(u, p, "get_live_categories"),
        xtreamAction(u, p, "get_live_streams"),
      ]);
      const { key, iv } = deriveKeyIv(u, p);
      const result = buildLiveCategories(categories, groupByCategory(allStreams), publicBaseUrl, u, p, key, iv);
      res.json(result);
    } catch (e) {
      console.error("[bridge] content/live error:", e.message);
      res.json([]);
    }
  });

  router.get("/apis-protect/content/movies", async (req, res) => {
    const { u, p } = req.query;
    if (!u || !p) return res.json([]);
    try {
      const [categories, allStreams] = await Promise.all([
        xtreamAction(u, p, "get_vod_categories"),
        xtreamAction(u, p, "get_vod_streams"),
      ]);
      const { key, iv } = deriveKeyIv(u, p);
      const result = buildVodCategories(categories, groupByCategory(allStreams), publicBaseUrl, u, p, key, iv);
      res.json(result);
    } catch (e) {
      console.error("[bridge] content/movies error:", e.message);
      res.json([]);
    }
  });

  router.get("/apis-protect/content/series", async (req, res) => {
    const { u, p } = req.query;
    if (!u || !p) return res.json([]);
    try {
      const [categories, allSeries] = await Promise.all([
        xtreamAction(u, p, "get_series_categories"),
        xtreamAction(u, p, "get_series"),
      ]);
      // Episodios no se cargan acá por defecto (más rápido). Ver README para
      // activar el fetch de get_series_info si la app los necesita de entrada.
      const { key, iv } = deriveKeyIv(u, p);
      const result = buildSeriesCategories(categories, groupByCategory(allSeries), publicBaseUrl, u, p, key, iv);
      res.json(result);
    } catch (e) {
      console.error("[bridge] content/series error:", e.message);
      res.json([]);
    }
  });

  router.get("/apis-protect/content/anime", async (req, res) => {
    res.json([]);
  });

  // ------------------------------------------------------------------
  // Endpoints secundarios (stubs "todo OK" — no rompen pantallas de ajustes)
  // ------------------------------------------------------------------
  // "verificar_device.php" espera el BODY como texto plano, no JSON:
  // "dispositivo_activo" | "dispositivo_desactivado" | cualquier otra cosa (error).
  router.post("/apis-protect/verificar_device.php", (req, res) => {
    res.type("text/plain").send("dispositivo_activo");
  });

  // "fecha_2.php" espera un ARRAY JSON con un objeto adentro:
  // [{ status, restan, plan, expira, list, movies, series }]
  // status !== "expirado" para que la cuenta se considere vigente.
  router.post("/apis-protect/fecha_2.php", (req, res) => {
    res.json([
      {
        status: "activo",
        restan: "",
        plan: "",
        expira: "",
        list: "",
        movies: "",
        series: "",
      },
    ]);
  });
  router.post("/apis-protect/eliminar_dispositivo.php", (req, res) => res.json({ response: { message: "ok" } }));
  router.post("/apis-protect/eliminar_device.php", (req, res) => res.json({ response: { message: "ok" } }));
  // Espera un ARRAY JSON de sesiones (objetos con id_dispositivo/device_name/etc.).
  // Vacío es un caso válido ("No se encontraron sesiones activas").
  router.post("/apis-protect/sesiones_activas_api.php", (req, res) => res.json([]));
  // "update.php" espera un ARRAY JSON: [{ "response": "...", "url": "..." }]
  // Si "response" es "desactualizado" la app muestra un diálogo de update.
  const updateResponse = () => [{ response: "actualizado", url: "" }];
  router.post("/apis-protect/update.php", (req, res) => res.json(updateResponse()));
  router.get("/apis-protect/update.php", (req, res) => res.json(updateResponse()));
  router.post("/apis-protect/security_log.php", (req, res) => res.status(200).send("ok"));

  return router;
};
