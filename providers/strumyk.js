
/*
 * STRUMYK HTML INSPECTOR v0.2.3
 * Nuvio iPad / iOS
 *
 * Katalog pozostaje na Cloudflare.
 *
 * Diagnostyka:
 * - wykonanie getStreams
 * - odpowiedz Workera
 * - HTTP strony odtwarzacza
 * - script, iframe, video, source
 * - rozpoznanie bibliotek odtwarzaczy
 * - wskazniki dynamicznego ladowania
 * - liczba jawnych adresow wideo
 *
 * Nie pobiera dodatkowych skryptow.
 * Nie ujawnia cookies, tokenow ani URL-i sesyjnych.
 * Nie obchodzi blokad dostepu.
 *
 * DEBUG: pozycje nie sa filmami.
 * Nie nalezy ich odtwarzac.
 */

var VERSION = "0.2.3";

var WORKER =
  "https://strumyk-stremio-addon.karotu1994.workers.dev";

var TEST_HLS =
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

var MAX_HTML = 400000;
var MAX_PAGES = 3;

function log(text) {
  try {
    console.log(
      "[STRUMYK INSPECTOR " +
      VERSION + "] " +
      String(text)
    );
  } catch (e) {}
}

function errorText(e) {
  return String(
    e && e.message ? e.message : e
  ).slice(0, 75);
}

function safeUrl(raw, base) {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > 4096
  ) return null;

  try {
    var u = base
      ? new URL(raw, base)
      : new URL(raw);

    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      (u.port && u.port !== "443")
    ) return null;

    var h = u.hostname.toLowerCase();

    if (
      h === "localhost" ||
      h.endsWith(".localhost") ||
      h.endsWith(".local") ||
      h.endsWith(".internal") ||
      h.endsWith(".arpa") ||
      h.indexOf(":") !== -1 ||
      /^[0-9.]+$/.test(h)
    ) return null;

    return u.href;
  } catch (e) {
    return null;
  }
}

function videoType(raw) {
  try {
    var path = new URL(raw).pathname.toLowerCase();

    if (/\.m3u8$/.test(path)) return "HLS";
    if (/\.mp4$/.test(path)) return "MP4";
    if (/\.m4v$/.test(path)) return "M4V";
    if (/\.webm$/.test(path)) return "WEBM";
    if (/\.mpd$/.test(path)) return "DASH";
  } catch (e) {}

  return null;
}

function countMatches(html, regex) {
  var matches = html.match(regex);
  return matches ? matches.length : 0;
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/&#x26;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&");
}

function getAttribute(tag, attribute) {
  var pattern = new RegExp(
    "(?:^|\\s)" + attribute +
    "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
    "i"
  );

  var match = tag.match(pattern);

  return match
    ? (match[1] || match[2] || match[3] || "")
    : null;
}

function getTags(html, name, limit) {
  var regex = new RegExp(
    "<" + name + "\\b[^>]*>",
    "gi"
  );

  var result = [];
  var match;

  while (
    (match = regex.exec(html)) !== null &&
    result.length < limit
  ) {
    result.push(match[0]);
  }

  return result;
}

function unique(values) {
  var result = [];
  var seen = {};

  for (var i = 0; i < values.length; i++) {
    var item = values[i];

    if (!item || seen[item]) continue;

    seen[item] = true;
    result.push(item);
  }

  return result;
}

/*
 * Zliczamy potencjalne URL-e wideo.
 * Nie wyswietlamy adresow ani parametrow.
 */
function extractVideos(html, base) {
  var patterns = [
    /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<video\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /(?:file|source|src|hls|videoUrl|streamUrl)\s*:\s*["']([^"']+)["']/gi,
    /["'](?:file|source|src|hls|videoUrl|streamUrl)["']\s*:\s*["']([^"']+)["']/gi,
    /https:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4|mpd|webm)(?:\?[^\s"'<>\\]*)?/gi
  ];

  var found = [];

  for (var i = 0; i < patterns.length; i++) {
    var match;
    var checked = 0;

    while (
      (match = patterns[i].exec(html)) !== null &&
      checked++ < 80 &&
      found.length < 24
    ) {
      var url = safeUrl(
        decodeHtml(match[1] || match[0]),
        base
      );

      if (url && videoType(url)) {
        found.push(url);
      }
    }
  }

  return unique(found);
}

function inspectHtml(html, base) {
  var scripts = getTags(html, "script", 120);
  var frames = getTags(html, "iframe", 80);
  var videos = getTags(html, "video", 80);
  var sources = getTags(html, "source", 120);

  var externalScripts = 0;
  var inlineScripts = 0;
  var iframeSrc = 0;
  var videoSrc = 0;
  var sourceSrc = 0;

  var scriptPaths = [];
  var frameHosts = [];

  for (var i = 0; i < scripts.length; i++) {
    var src = getAttribute(scripts[i], "src");

    if (src) {
      externalScripts++;

      try {
        var u = new URL(src, base);

        // Nazwa pliku bez query i fragmentu.
        var file = u.pathname.split("/").pop();

        if (file) {
          scriptPaths.push(
            file.slice(0, 45)
          );
        }
      } catch (e) {}
    } else {
      inlineScripts++;
    }
  }

  for (var j = 0; j < frames.length; j++) {
    var frame = getAttribute(frames[j], "src");

    if (!frame) continue;

    iframeSrc++;

    try {
      var host = new URL(frame, base).hostname;

      if (
        host &&
        host !== "localhost" &&
        host.indexOf(":") === -1
      ) {
        frameHosts.push(
          host.slice(0, 65)
        );
      }
    } catch (e) {}
  }

  for (var k = 0; k < videos.length; k++) {
    if (getAttribute(videos[k], "src")) {
      videoSrc++;
    }
  }

  for (var s = 0; s < sources.length; s++) {
    if (getAttribute(sources[s], "src")) {
      sourceSrc++;
    }
  }

  var playerNames = [];
  var checks = [
    ["Clappr", /\bclappr\b/i],
    ["JWPlayer", /\bjwplayer\b|jwplayer\.js/i],
    ["VideoJS", /\bvideojs\b|video-js/i],
    ["HLSjs", /\bhls\.js\b|new\s+Hls\s*\(/i],
    ["Shaka", /\bshaka\b/i],
    ["Plyr", /\bplyr\b/i],
    ["DPlayer", /\bdplayer\b/i],
    ["ArtPlayer", /\bartplayer\b/i],
    ["FluidPlayer", /\bfluidplayer\b/i],
    ["DashJS", /\bdashjs\b/i]
  ];

  for (var x = 0; x < checks.length; x++) {
    if (checks[x][1].test(html)) {
      playerNames.push(checks[x][0]);
    }
  }

  var dynamic = [];

  if (/document\.createElement\s*\(/i.test(html)) {
    dynamic.push("createElement");
  }

  if (/\bfetch\s*\(/i.test(html)) {
    dynamic.push("fetch()");
  }

  if (/\bXMLHttpRequest\b/i.test(html)) {
    dynamic.push("XHR");
  }

  if (/\bimport\s*\(/i.test(html)) {
    dynamic.push("dynamic import");
  }

  if (/\.appendChild\s*\(/i.test(html)) {
    dynamic.push("appendChild");
  }

  if (/\.m3u8\b/i.test(html)) {
    dynamic.push("m3u8 mentioned");
  }

  if (/\.mpd\b/i.test(html)) {
    dynamic.push("mpd mentioned");
  }

  var candidates = extractVideos(html, base);

  var types = {
    HLS: 0,
    MP4: 0,
    DASH: 0,
    OTHER: 0
  };

  for (var z = 0; z < candidates.length; z++) {
    var type = videoType(candidates[z]);

    if (type === "HLS") types.HLS++;
    else if (type === "MP4") types.MP4++;
    else if (type === "DASH") types.DASH++;
    else types.OTHER++;
  }

  return {
    bytes: html.length,
    scripts: scripts.length,
    externalScripts: externalScripts,
    inlineScripts: inlineScripts,
    scriptNames: unique(scriptPaths).slice(0, 5),
    iframes: frames.length,
    iframeSrc: iframeSrc,
    frameHosts: unique(frameHosts).slice(0, 3),
    videos: videos.length,
    videoSrc: videoSrc,
    sources: sources.length,
    sourceSrc: sourceSrc,
    players: playerNames,
    dynamic: dynamic,
    candidates: candidates.length,
    types: types,
    blocked:
      /cf-chl-|just a moment|sprawdzamy połączenie|sorry, you have been blocked|direct access is prohibited|access denied/i
        .test(html)
  };
}

function request(url, accept) {
  return fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: {
      Accept: accept || "*/*"
    }
  });
}

/*
 * Debug umieszczamy w NAME,
 * bo to pole Nuvio faktycznie pokazuje.
 *
 * Kazdy DEBUG wskazuje JSON /health.
 * Nie jest to odtwarzalny strumien.
 */
function debugRow(number, text) {
  var detail = String(text)
    .replace(/[\r\n]+/g, " ")
    .slice(0, 125);

  log("DEBUG " + number + ": " + detail);

  return {
    name: "DEBUG " + number + " | " + detail,
    title: "NIE ODTWARZAC",
    quality: "DEBUG",
    url:
      WORKER +
      "/health?inspector=" +
      encodeURIComponent(number)
  };
}

function videoRow(url, label) {
  var type = videoType(url) || "VIDEO";

  return {
    name: "Strumyk Native " + type,
    title: String(label).slice(0, 95),
    quality: "Auto",
    url: url
  };
}

function loadPage(address) {
  return request(address, "text/html")
    .then(function(response) {
      if (!response.ok) {
        return {
          http: response.status,
          error: "HTTP " + response.status,
          info: null
        };
      }

      var contentType = String(
        response.headers.get("content-type") || ""
      ).toLowerCase();

      if (
        contentType &&
        contentType.indexOf("html") === -1 &&
        contentType.indexOf("text/plain") === -1
      ) {
        return {
          http: response.status,
          error: "Odpowiedz nie jest HTML",
          info: null
        };
      }

      var declared = Number(
        response.headers.get("content-length") || 0
      );

      if (declared > MAX_HTML) {
        return {
          http: response.status,
          error: "HTML przekracza limit",
          info: null
        };
      }

      return response.text()
        .then(function(html) {
          if (html.length > MAX_HTML) {
            return {
              http: response.status,
              error: "HTML przekracza limit",
              info: null
            };
          }

          return {
            http: response.status,
            error: null,
            info: inspectHtml(
              html,
              address
            )
          };
        });
    })
    .catch(function(e) {
      return {
        http: 0,
        error: "FETCH ERROR: " + errorText(e),
        info: null
      };
    });
}

function inspectEventPages(pages, debug, videos) {
  function next(index) {
    if (
      index >= pages.length ||
      index >= MAX_PAGES
    ) {
      debug.push(
        debugRow(
          99,
          "KONIEC | zrodla wideo=" +
          videos.length
        )
      );

      return Promise.resolve(
        videos.concat(debug)
      );
    }

    var page = pages[index];

    return loadPage(page.url)
      .then(function(result) {
        var baseNumber = 10 + index * 10;

        debug.push(
          debugRow(
            baseNumber,
            "WWW " + (index + 1) +
            " | HTTP " + result.http +
            (result.error
              ? " | " + result.error
              : "")
          )
        );

        var info = result.info;

        if (!info) {
          return next(index + 1);
        }

        debug.push(
          debugRow(
            baseNumber + 1,
            "HTML bytes=" + info.bytes +
            " | Blocked=" + info.blocked
          )
        );

        debug.push(
          debugRow(
            baseNumber + 2,
            "script=" + info.scripts +
            " | external=" + info.externalScripts +
            " | inline=" + info.inlineScripts
          )
        );

        debug.push(
          debugRow(
            baseNumber + 3,
            "JS files: " +
            (
              info.scriptNames.length
                ? info.scriptNames.join(", ")
                : "brak"
            )
          )
        );

        debug.push(
          debugRow(
            baseNumber + 4,
            "iframe=" + info.iframes +
            " | src=" + info.iframeSrc +
            " | hosts: " +
            (
              info.frameHosts.length
                ? info.frameHosts.join(", ")
                : "brak"
            )
          )
        );

        debug.push(
          debugRow(
            baseNumber + 5,
            "video=" + info.videos +
            " | video.src=" + info.videoSrc +
            " | source=" + info.sources +
            " | source.src=" + info.sourceSrc
          )
        );

        debug.push(
          debugRow(
            baseNumber + 6,
            "Player: " +
            (
              info.players.length
                ? info.players.join(", ")
                : "nierozpoznany"
            )
          )
        );

        debug.push(
          debugRow(
            baseNumber + 7,
            "JS hints: " +
            (
              info.dynamic.length
                ? info.dynamic.join(", ")
                : "brak"
            )
          )
        );

        debug.push(
          debugRow(
            baseNumber + 8,
            "Video URL candidates=" +
            info.candidates +
            " | HLS=" + info.types.HLS +
            " MP4=" + info.types.MP4 +
            " DASH=" + info.types.DASH
          )
        );

        return next(index + 1);
      });
  }

  return next(0);
}

function getStreams(tmdbId, mediaType, season, episode) {
  var id = String(
    tmdbId == null ? "" : tmdbId
  ).trim();

  log(
    "getStreams id=" + id +
    " mediaType=" + mediaType
  );

  if (mediaType !== "movie") {
    return Promise.resolve([]);
  }

  /*
   * Zachowujemy dzialajacy test HLS.
   */
  if (id === "strumyk:test-hls") {
    return Promise.resolve([
      {
        name: "Strumyk Native TEST",
        title: "Big Buck Bunny HLS",
        quality: "1080p",
        url: TEST_HLS
      }
    ]);
  }

  if (
    !/^strumyk:[A-Za-z0-9_-]{1,80}$/.test(id)
  ) {
    return Promise.resolve([]);
  }

  var debug = [
    debugRow(1, "getStreams ID=" + id)
  ];

  var endpoint =
    WORKER +
    "/stream/movie/" +
    encodeURIComponent(id) +
    ".json";

  return request(endpoint, "application/json")
    .then(function(response) {
      debug.push(
        debugRow(
          2,
          "Cloudflare HTTP " + response.status
        )
      );

      if (!response.ok) return null;

      return response.json();
    })
    .then(function(data) {
      if (
        !data ||
        !Array.isArray(data.streams)
      ) {
        debug.push(
          debugRow(
            3,
            "Brak poprawnej listy streams"
          )
        );

        return debug;
      }

      var streams = data.streams;
      var pages = [];
      var videos = [];
      var seen = {};

      for (var i = 0; i < streams.length; i++) {
        var item = streams[i];

        if (!item) continue;

        var label = String(
          item.title ||
          item.name ||
          "Zrodlo"
        );

        var direct = safeUrl(item.url);
        var external = safeUrl(
          item.externalUrl
        );

        if (
          direct &&
          videoType(direct) &&
          !seen[direct]
        ) {
          seen[direct] = true;

          videos.push(
            videoRow(direct, label)
          );
        }

        if (
          external &&
          !videoType(external) &&
          !seen[external]
        ) {
          seen[external] = true;

          pages.push({
            url: external,
            label: label
          });
        }
      }

      debug.push(
        debugRow(
          3,
          "Worker sources=" +
          streams.length +
          " | direct video=" +
          videos.length +
          " | WWW=" +
          pages.length
        )
      );

      return inspectEventPages(
        pages,
        debug,
        videos
      );
    })
    .catch(function(e) {
      debug.push(
        debugRow(
          98,
          "ERROR: " + errorText(e)
        )
      );

      return debug;
    });
}

module.exports = {
  getStreams: getStreams
};
