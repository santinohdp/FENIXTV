// translator.js
//
// Traduce categorías/streams de Xtream Codes al esquema Category/Channel que
// espera la app Android "TV" (com.tv.tv), deducido de Category.smali /
// Channel.smali:
//
//   Category: { name, mode, lista: Channel[] }
//   Channel:  { name, uri, ico, iconpng, iconoHorizontal, descripcion, info,
//               tipo, prot, headers, cookie, agente, xauth, token_now,
//               drm_license_url, drm_scheme, cdn_url, location_url,
//               device_uuid, check, web, temporada: [] }
//
// IMPORTANTE (confirmado leyendo el smali):
//  - Los adapters de pantalla usan el campo "ico" para la miniatura, NO
//    "iconpng" — así que "ico" tiene que tener la URL del logo.
//  - PlayerActivity desencripta "uri" con AES antes de reproducir (mismo
//    key/iv de la sesión), así que "uri" va CIFRADO, no en texto plano.

const { encryptAES } = require("./crypto");

function emptyChannelExtras() {
  return {
    iconpng: "",
    iconoHorizontal: "",
    descripcion: "",
    info: "",
    prot: "",
    headers: "",
    cookie: "",
    agente: "",
    xauth: "",
    token_now: "",
    drm_license_url: "",
    drm_scheme: "",
    cdn_url: "",
    location_url: "",
    device_uuid: "",
    check: "",
    web: "",
  };
}

function liveUrl(base, user, pass, streamId) {
  return `${base}/live/${user}/${pass}/${streamId}`;
}

function movieUrl(base, user, pass, streamId, ext) {
  return `${base}/movie/${user}/${pass}/${streamId}.${ext || "mp4"}`;
}

function seriesUrl(base, user, pass, episodeId, ext) {
  return `${base}/series/${user}/${pass}/${episodeId}.${ext || "mp4"}`;
}

function enc(url, key, iv) {
  return encryptAES(url, key, iv);
}

function buildLiveCategories(categories, streamsByCategory, base, user, pass, key, iv) {
  return categories.map((cat) => ({
    name: cat.category_name || "Sin nombre",
    mode: false,
    lista: (streamsByCategory[cat.category_id] || []).map((s) => ({
      name: s.name || "Canal",
      uri: enc(liveUrl(base, user, pass, s.stream_id), key, iv),
      ico: s.stream_icon || "",
      tipo: "live",
      temporada: [],
      ...emptyChannelExtras(),
    })),
  }));
}

function buildVodCategories(categories, streamsByCategory, base, user, pass, key, iv) {
  return categories.map((cat) => ({
    name: cat.category_name || "Sin nombre",
    mode: false,
    lista: (streamsByCategory[cat.category_id] || []).map((s) => ({
      name: s.name || "Película",
      uri: enc(movieUrl(base, user, pass, s.stream_id, s.container_extension), key, iv),
      ico: s.stream_icon || "",
      tipo: "movie",
      temporada: [],
      ...emptyChannelExtras(),
    })),
  }));
}

/**
 * seriesInfoById (opcional): Map series_id(string) -> resultado de
 * action=get_series_info, para incluir episodios reales en "temporada".
 * Si no se pasa, "temporada" queda vacío (listado más rápido).
 */
function buildSeriesCategories(categories, seriesByCategory, base, user, pass, key, iv, seriesInfoById) {
  return categories.map((cat) => ({
    name: cat.category_name || "Sin nombre",
    mode: false,
    lista: (seriesByCategory[cat.category_id] || []).map((s) => {
      const episodes = [];
      const info = seriesInfoById && seriesInfoById.get(String(s.series_id));
      if (info && info.episodes) {
        for (const seasonNum of Object.keys(info.episodes)) {
          for (const ep of info.episodes[seasonNum]) {
            episodes.push({
              name: `T${seasonNum} - ${ep.title || "Episodio " + ep.episode_num}`,
              uri: enc(seriesUrl(base, user, pass, ep.id, ep.container_extension), key, iv),
              ico: (ep.info && ep.info.movie_image) || s.cover || "",
              tipo: "episode",
              temporada: [],
              ...emptyChannelExtras(),
            });
          }
        }
      }
      return {
        name: s.name || "Serie",
        uri: "",
        ico: s.cover || "",
        tipo: "series",
        temporada: episodes,
        ...emptyChannelExtras(),
      };
    }),
  }));
}

module.exports = { buildLiveCategories, buildVodCategories, buildSeriesCategories };
