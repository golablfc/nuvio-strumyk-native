
/*
 * STRUMYK NATIVE DEBUG 0.2.1
 * Nuvio iPad / iOS
 *
 * Testujemy:
 * 1. Wywolanie getStreams
 * 2. Komunikacje z Cloudflare
 * 3. Liste zrodel wydarzenia
 * 4. Dostepnosc HTML odtwarzacza
 * 5. Jawne adresy HLS / MP4 / DASH
 *
 * Pozycje DEBUG to nie sa filmy.
 * Ich URL wskazuje JSON, nie transmisje.
 *
 * Bez cookies, tokenow, referer spoofingu,
 * proxy i obchodzenia zabezpieczen.
 */

var VERSION = "0.2.1";

var WORKER =
  "https://strumyk-stremio-addon.karotu1994.workers.dev";

var TEST_HLS =
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

var MAX_PAGES = 3;
var MAX_HTML = 350000;

function log(message) {
  try {
    console.log(
      "[STRUMYK-DEBUG] " + String(message)
    );
  } catch (e) {}
}

function errText(e) {
  return String(
    e && e.message ? e.message : e
  ).slice(0, 100);
}

function safeUrl(raw, base) {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > 4096
  ) return null;

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
      host.indexOf(":") !== -1 ||
      /^[0-9.]+$/.test(host)
    ) return null;

    return u.href;
  } catch (e) {
    return null;
  }
}

function videoType(raw) {
  try {
    var path = new URL(raw)
      .pathname.toLowerCase();

    if (/\.m3u8$/.test(path)) return "HLS";
    if (/\.mp4$/.test(path)) return "MP4";
    if (/\.m4v$/.test(path)) return "M4V";
    if (/\.webm$/.test(path)) return "WEBM";
    if (/\.mpd$/.test(path)) return "DASH";
  } catch (e) {}

  return null;
}

function decodeHtml(raw) {
  return String(raw)
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/&#x26;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&");
}

function extractVideoUrls(html, base) {
  var results = [];
  var seen = {};

  var expressions = [
    /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<video\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /(?:file|source|src|hls|videoUrl|streamUrl)\s*:\s*["']([^"']+)["']/gi,
    /["'](?:file|source|src|hls|videoUrl|streamUrl)["']\s*:\s*["']([^"']+)["']/gi,
    /https:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4|mpd|webm)(?:\?[^\s"'<>\\]*)?/gi
  ];

  for (var i = 0; i < expressions.length; i++) {
    var match;
    var count = 0;

    while (
      (match = expressions[i].exec(html)) !== null &&
      count < 60 &&
      results.length < 12
    ) {
      count++;

      var raw = decodeHtml(
        match[1] || match[0]
      );

      var url = safeUrl(raw, base);

      if (
        !url ||
        !videoType(url) ||
        seen[url]
      ) continue;

      seen[url] = true;
      results.push(url);
    }
  }

  return results;
}

function request(url, accept) {
  return fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: {
      "Accept": accept || "*/*"
    }
  });
}

function diagnosticRow(number, message) {
  var text = String(message).slice(0, 140);

  log("STEP " + number + ": " + text);

  return {
    name: "DEBUG " + number + " - NIE ODTWARZAC",
    title: text,
    quality: "DEBUG",
    // Celowo JSON, a nie plik wideo.
    url: WORKER + "/health?diagnostic=" + number
  };
}

function videoRow(url, label) {
  return {
    name: "Strumyk Native " +
      (videoType(url) || "Video"),
    title: String(label).slice(0, 90),
    quality: "Auto",
    url: url
  };
}

function readExternalPage(address) {
  return request(address, "text/html")
    .then(function(response) {
      var code = response.status;

      if (!response.ok) {
        return {
          status: "HTTP " + code,
          urls: []
        };
      }

      var ct = String(
        response.headers.get("content-type") || ""
      ).toLowerCase();

      if (
        ct &&
        ct.indexOf("html") === -1 &&
        ct.indexOf("text/plain") === -1
      ) {
        return {
          status: "Nie-HTML (" +
            ct.slice(0, 35) + ")",
          urls: []
        };
      }

      var length = Number(
        response.headers.get("content-length") || 0
      );

      if (length > MAX_HTML) {
        return {
          status: "HTML za duzy",
          urls: []
        };
      }

      return response.text()
        .then(function(html) {
          if (html.length > MAX_HTML) {
            return {
              status: "HTML za duzy",
              urls: []
            };
          }

          if (
            /cf-chl-|just a moment|sprawdzamy połączenie|sorry, you have been blocked|direct access is prohibited|access denied/i
              .test(html)
          ) {
            return {
              status: "Blokada strony / weryfikacja",
              urls: []
            };
          }

          var urls = extractVideoUrls(
            html,
            address
          );

          return {
            status:
              "HTTP " + code +
              ", jawne video: " + urls.length,
            urls: urls
          };
        });
    })
    .catch(function(e) {
      return {
        status: "Blad fetch: " + errText(e),
        urls: []
      };
    });
}

function getStreams(
  tmdbId,
  mediaType,
  season,
  episode
) {
  var id = String(
    tmdbId == null ? "" : tmdbId
  ).trim();

  log(
    "START id=" + id +
    " type=" + mediaType
  );

  if (mediaType !== "movie") {
    return Promise.resolve([]);
  }

  if (id === "strumyk:test-hls") {
    return Promise.resolve([
      {
        name: "Strumyk Native TEST",
        title: "Big Buck Bunny - publiczny HLS",
        quality: "1080p",
        url: TEST_HLS
      },
      diagnosticRow(
        1,
        "OK: getStreams uruchomione dla test HLS"
      )
    ]);
  }

  if (
    !/^strumyk:[A-Za-z0-9_-]{1,80}$/.test(id)
  ) {
    return Promise.resolve([]);
  }

  var debug = [];

  debug.push(
    diagnosticRow(
      1,
      "OK getStreams | ID: " + id
    )
  );

  var endpoint =
    WORKER + "/stream/movie/" +
    encodeURIComponent(id) + ".json";

  return request(
    endpoint,
    "application/json"
  )
    .then(function(response) {
      debug.push(
        diagnosticRow(
          2,
          "Worker HTTP " + response.status
        )
      );

      if (!response.ok) {
        return {
          error:
            "Worker zwrocil HTTP " +
            response.status
        };
      }

      return response.json();
    })
    .then(function(data) {
      if (data.error) {
        debug.push(
          diagnosticRow(
            3,
            "Blad API: " + data.error
          )
        );

        return debug;
      }

      var rows = Array.isArray(data.streams)
        ? data.streams
        : [];

      var direct = [];
      var pages = [];
      var seen = {};

      for (var i = 0; i < rows.length; i++) {
        var item = rows[i];

        if (!item) continue;

        var label = String(
          item.title || item.name || "Zrodlo"
        );

        var directUrl = safeUrl(item.url);
        var webUrl = safeUrl(item.externalUrl);

        if (
          directUrl &&
          videoType(directUrl) &&
          !seen[directUrl]
        ) {
          seen[directUrl] = true;

          direct.push({
            url: directUrl,
            label: label
          });
        }

        if (
          webUrl &&
          !videoType(webUrl) &&
          !seen[webUrl]
        ) {
          seen[webUrl] = true;

          pages.push({
            url: webUrl,
            label: label
          });
        }
      }

      debug.push(
        diagnosticRow(
          3,
          "Zrodla z Workera: " + rows.length +
          " | Video: " + direct.length +
          " | WWW: " + pages.length
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

      function scanNext(index) {
        if (
          index >= pages.length ||
          index >= MAX_PAGES
        ) {
          debug.push(
            diagnosticRow(
              9,
              "KONIEC: " +
              videos.length +
              " kandydatow video. " +
              (videos.length
                ? "Sprawdz odtwarzanie."
                : "Brak natywnego zrodla.")
            )
          );

          return Promise.resolve(
            videos.concat(debug)
          );
        }

        var page = pages[index];

        return readExternalPage(page.url)
          .then(function(result) {
            debug.push(
              diagnosticRow(
                4 + index,
                "WWW " + (index + 1) +
                ": " + result.status
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
                videoRow(url, page.label)
              );
            }

            return scanNext(index + 1);
          });
      }

      return scanNext(0);
    })
    .catch(function(e) {
      debug.push(
        diagnosticRow(
          8,
          "BLAD: " + errText(e)
        )
      );

      return debug;
    });
}

module.exports = {
  getStreams: getStreams
};
