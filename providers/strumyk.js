
/*
 * STRUMYK NATIVE DEBUG v0.2.2
 * Diagnostyka widoczna na iPadzie.
 *
 * Nie zmienia Cloudflare Workera.
 * Nie obchodzi HTTP 403, DRM ani blokad.
 */

var VERSION = "0.2.2";

var WORKER =
  "https://strumyk-stremio-addon.karotu1994.workers.dev";

var TEST_HLS =
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

var MAX_PAGES = 3;
var MAX_HTML = 350000;

function log(s) {
  try {
    console.log("[STRUMYK " + VERSION + "] " + s);
  } catch (e) {}
}

function message(error) {
  return String(
    error && error.message ? error.message : error
  ).slice(0, 90);
}

function safeUrl(raw, base) {
  if (typeof raw !== "string" || raw.length > 4096) {
    return null;
  }

  try {
    var u = new URL(raw, base);

    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      (u.port && u.port !== "443")
    ) return null;

    var host = u.hostname.toLowerCase();

    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host.endsWith(".arpa") ||
      host.indexOf(":") >= 0 ||
      /^[0-9.]+$/.test(host)
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

function extractVideo(html, base) {
  var found = [];
  var seen = {};

  var patterns = [
    /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<video\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /(?:file|src|source|hls|videoUrl|streamUrl)\s*:\s*["']([^"']+)["']/gi,
    /["'](?:file|src|source|hls|videoUrl|streamUrl)["']\s*:\s*["']([^"']+)["']/gi,
    /https:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4|mpd|webm)(?:\?[^\s"'<>\\]*)?/gi
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match;
    var n = 0;

    while (
      (match = patterns[i].exec(html)) !== null &&
      n++ < 60 &&
      found.length < 12
    ) {
      var url = safeUrl(
        decodeHtml(match[1] || match[0]),
        base
      );

      if (!url || !videoType(url) || seen[url]) {
        continue;
      }

      seen[url] = true;
      found.push(url);
    }
  }

  return found;
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
 * Wersja diagnostyczna:
 * komunikat umieszczamy w NAME,
 * bo to pole Nuvio pokazuje.
 *
 * Adres prowadzi do JSON, nie wideo.
 * NIE KLIKAC wpisów DEBUG.
 */
function debugRow(number, text) {
  var detail = String(text).slice(0, 105);

  log("DEBUG " + number + ": " + detail);

  return {
    name: "DEBUG " + number + " | " + detail,
    title: "NIE ODTWARZAC — " + detail,
    quality: "DEBUG",
    url: WORKER + "/health?debug=" + number
  };
}

function videoRow(url, label) {
  var type = videoType(url) || "VIDEO";

  return {
    name: "Strumyk Native " + type,
    title: String(label).slice(0, 110),
    quality: "Auto",
    url: url
  };
}

function readPage(url) {
  return request(url, "text/html")
    .then(function(response) {
      if (!response.ok) {
        return {
          status: "HTTP " + response.status,
          urls: []
        };
      }

      var ct = String(
        response.headers.get("content-type") || ""
      ).toLowerCase();

      if (
        ct &&
        ct.indexOf("html") < 0 &&
        ct.indexOf("text/plain") < 0
      ) {
        return {
          status: "Nie-HTML",
          urls: []
        };
      }

      var size = Number(
        response.headers.get("content-length") || 0
      );

      if (size > MAX_HTML) {
        return {
          status: "Za duzy HTML",
          urls: []
        };
      }

      return response.text().then(function(html) {
        if (html.length > MAX_HTML) {
          return {
            status: "Za duzy HTML",
            urls: []
          };
        }

        if (
          /cf-chl-|just a moment|sprawdzamy połączenie|sorry, you have been blocked|direct access is prohibited|access denied/i
            .test(html)
        ) {
          return {
            status: "BLOKADA / weryfikacja",
            urls: []
          };
        }

        var urls = extractVideo(html, url);

        return {
          status: "HTTP 200 | video=" + urls.length,
          urls: urls
        };
      });
    })
    .catch(function(error) {
      return {
        status: "FETCH ERROR: " + message(error),
        urls: []
      };
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
  var id = String(
    tmdbId == null ? "" : tmdbId
  ).trim();

  if (mediaType !== "movie") {
    return Promise.resolve([]);
  }

  if (id === "strumyk:test-hls") {
    return Promise.resolve([
      {
        name: "Strumyk Native TEST",
        title: "Big Buck Bunny · HLS",
        quality: "1080p",
        url: TEST_HLS
      },
      debugRow(1, "OK — natywny plugin dziala")
    ]);
  }

  if (!/^strumyk:[A-Za-z0-9_-]{1,80}$/.test(id)) {
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
          "Worker HTTP " + response.status
        )
      );

      if (!response.ok) {
        return null;
      }

      return response.json();
    })
    .then(function(data) {
      if (!data || !Array.isArray(data.streams)) {
        debug.push(
          debugRow(3, "Brak tablicy streams")
        );
        return debug;
      }

      var rows = data.streams;
      var pages = [];
      var direct = [];
      var seen = {};

      for (var i = 0; i < rows.length; i++) {
        var item = rows[i];

        if (!item) continue;

        var label = String(
          item.title || item.name || "Zrodlo"
        );

        var url = safeUrl(item.url);
        var external = safeUrl(item.externalUrl);

        if (url && videoType(url) && !seen[url]) {
          seen[url] = true;

          direct.push({
            url: url,
            label: label
          });
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
          "Worker sources=" + rows.length +
          " | video=" + direct.length +
          " | WWW=" + pages.length
        )
      );

      var videos = [];
      var videoSeen = {};

      for (var d = 0; d < direct.length; d++) {
        videoSeen[direct[d].url] = true;

        videos.push(
          videoRow(
            direct[d].url,
            direct[d].label
          )
        );
      }

      function scan(index) {
        if (
          index >= pages.length ||
          index >= MAX_PAGES
        ) {
          debug.push(
            debugRow(
              9,
              "KONIEC | znalezione video=" +
              videos.length
            )
          );

          return Promise.resolve(
            videos.concat(debug)
          );
        }

        return readPage(pages[index].url)
          .then(function(result) {
            debug.push(
              debugRow(
                4 + index,
                "WWW " + (index + 1) +
                " | " + result.status
              )
            );

            for (
              var j = 0;
              j < result.urls.length;
              j++
            ) {
              var url = result.urls[j];

              if (videoSeen[url]) continue;

              videoSeen[url] = true;

              videos.push(
                videoRow(
                  url,
                  pages[index].label
                )
              );
            }

            return scan(index + 1);
          });
      }

      return scan(0);
    })
    .catch(function(error) {
      debug.push(
        debugRow(
          8,
          "BLAD: " + message(error)
        )
      );

      return debug;
    });
}

module.exports = {
  getStreams: getStreams
};
