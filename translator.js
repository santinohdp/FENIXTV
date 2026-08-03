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
// Los "uri" apuntan a TUS PROPIAS rutas /live, /movie, /series de server.js
// (las que ya tenés y hacen streamProxy/pipeStream), no directo al proveedor.
// Así todo el tráfico de reproducción sigue pasando por tu servidor.

function emptyChannelExtras() {
  return {
    ico: "",
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
  // server.js le agrega ".m3u8" solo si streamId no tiene punto — lo dejamos así.
  return `${base}/live/${user}/${pass}/${streamId}`;
}

function movieUrl(base, user, pass, streamId, ext) {
  return `${base}/movie/${user}/${pass}/${streamId}.${ext || "mp4"}`;
}

function seriesUrl(base, user, pass, episodeId, ext) {
  return `${base}/series/${user}/${pass}/${episodeId}.${ext || "mp4"}`;
}

function buildLiveCategories(categories, streamsByCategory, base, user, pass) {
  return categories.map((cat) => ({
    name: cat.category_name || "Sin nombre",
    mode: false,
    lista: (streamsByCategory[cat.category_id] || []).map((s) => ({
      name: s.name || "Canal",
      uri: liveUrl(base, user, pass, s.stream_id),
      iconpng: s.stream_icon || "",
      tipo: "live",
      temporada: [],
      ...emptyChannelExtras(),
    })),
  }));
}

function buildVodCategories(categories, streamsByCategory, base, user, pass) {
  return categories.map((cat) => ({
    name: cat.category_name || "Sin nombre",
    mode: false,
    lista: (streamsByCategory[cat.category_id] || []).map((s) => ({
      name: s.name || "Película",
      uri: movieUrl(base, user, pass, s.stream_id, s.container_extension),
      iconpng: s.stream_icon || "",
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
function buildSeriesCategories(categories, seriesByCategory, base, user, pass, seriesInfoById) {
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
              uri: seriesUrl(base, user, pass, ep.id, ep.container_extension),
              iconpng: (ep.info && ep.info.movie_image) || s.cover || "",
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
        iconpng: s.cover || "",
        tipo: "series",
        temporada: episodes,
        ...emptyChannelExtras(),
      };
    }),
  }));
}

module.exports = { buildLiveCategories, buildVodCategories, buildSeriesCategories };
