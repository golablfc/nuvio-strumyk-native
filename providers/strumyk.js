
/*
 * Strumyk Native Resolver v0.2.0
 * Nuvio Android TV / Google TV
 *
 * Katalog: Cloudflare Worker
 * Resolver: lokalny JavaScript Nuvio
 *
 * Nie obchodzi HTTP 403, Cloudflare ani DRM.
 */

var VERSION = "0.2.0";

var WORKER =
  "https://strumyk-stremio-addon.karotu1994.workers.dev";

var TEST_HLS =
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

var MAX_PAGES = 4;
var MAX_HTML = 400000;
var TIMEOUT = 6500;

function log(message) {
  try {
    console.log(
      "[StrumykResolver " + VERSION + "] " +
      String(message)
    );
  } catch (e) {}
}

function errorText(error) {
  return String(
    error && error.message
      ? error.message
      : error
  ).slice(0, 200);
}

function isPrivateHost(host) {
  host = host.toLowerCase();

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".arpa") ||
    host === "[::1]"
  ) {
    return true;
  }

  // Nie wykonujemy żądań do adresów IP.
  if (/^[0-9.]+$/.test(host)) {
    return true;
  }

  if (host.indexOf(":") !== -1) {
    return true;
  }

  return false;
}

function safeUrl(raw, base) {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > 4096
  ) {
    return null;
  }

  try {
    var url = base
      ? new URL(raw, base)
      : new URL(raw);

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    ) {
      return null;
    }

    if (isPrivateHost(url.hostname)) {
      return null;
    }

    return url.href;
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

function uniqueUrls(urls) {
  var out = [];
  var seen = {};

  for (var i = 0; i < urls.length; i++) {
    var url = urls[i];

    if (!url || seen[url]) continue;

    seen[url] = true;
    out.push(url);
  }

  return out;
}

/*
 * Wyłącznie jawne adresy w HTML:
 * <video src>
 * <source src>
 * Konfiguracje file/src/source/hls
 * JSON videoUrl / streamUrl
 */
function extractFromHtml(html, base) {
  if (typeof html !== "string") return [];

  var patterns = [
    /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<video\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /(?:file|source|src|hls|videoUrl|streamUrl)\s*:\s*["']([^"']+)["']/gi,
    /["'](?:file|source|src|hls|videoUrl|streamUrl)["']\s*:\s*["']([^"']+)["']/gi,
    /https:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4|m4v|webm|mpd)(?:\?[^\s"'<>\\]*)?/gi
  ];

  var results = [];

  for (var p = 0; p < patterns.length; p++) {
    var expression = patterns[p];
    var match;
    var iterations = 0;

    while (
      (match = expression.exec(html)) !== null &&
      iterations < 80 &&
      results.length < 20
    ) {
      iterations++;

      var candidate = match[1] || match[0];
      candidate = decodeHtml(candidate);

      var url = safeUrl(candidate, base);

      if (!url || !videoType(url)) continue;

      results.push(url);
    }
  }

  return uniqueUrls(results).slice(0, 12);
}

/*
 * Pobieranie z timeoutem.
 * Nie wykonujemy przekierowań automatycznie.
 */
async function fetchWithTimeout(
  url,
  accept,
  timeoutMs
) {
  var controller =
    typeof AbortController !== "undefined"
      ? new AbortController()
      : null;

  var timer = null;

  var options = {
    method: "GET",
    redirect: "manual",
    headers: {
      "Accept": accept
    }
  };

  if (controller) {
    options.signal = controller.signal;

    timer = setTimeout(function() {
      controller.abort();
    }, timeoutMs || TIMEOUT);
  }

  try {
    return await fetch(url, options);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function loadWorkerStreams(id) {
  var endpoint =
    WORKER +
    "/stream/movie/" +
    encodeURIComponent(id) +
    ".json";

  log("WORKER: " + endpoint);

  var response = await fetchWithTimeout(
    endpoint,
    "application/json",
    TIMEOUT
  );

  log("WORKER HTTP: " + response.status);

  if (!response.ok) {
    throw new Error(
      "Worker HTTP " + response.status
    );
  }

  var data = await response.json();

  if (!data || !Array.isArray(data.streams)) {
    throw new Error(
      "Worker nie zwrocil tablicy streams"
    );
  }

  log("WORKER SOURCES: " + data.streams.length);

  return data.streams;
}

function findVideoUrls(streams) {
  var direct = [];
  var pages = [];
  var seenDirect = {};
  var seenPages = {};

  for (var i = 0; i < streams.length; i++) {
    var stream = streams[i];

    if (!stream) continue;

    var label = String(
      stream.title || stream.name || "Video"
    ).slice(0, 100);

    var directUrl = safeUrl(stream.url);

    if (
      directUrl &&
      videoType(directUrl) &&
      !seenDirect[directUrl]
    ) {
      seenDirect[directUrl] = true;

      direct.push({
        url: directUrl,
        label: label,
        type: videoType(directUrl)
      });
    }

    var externalUrl = safeUrl(
      stream.externalUrl
    );

    if (
      externalUrl &&
      !videoType(externalUrl) &&
      !seenPages[externalUrl]
    ) {
      seenPages[externalUrl] = true;

      pages.push({
        url: externalUrl,
        label: label
      });
    }
  }

  return {
    direct: direct,
    pages: pages
  };
}

async function resolveHtmlPage(page) {
  var diagnostic = {
    url: page.url,
    label: page.label,
    status: "unknown",
    count: 0
  };

  try {
    log("HTML CHECK: " + page.url);

    var response = await fetchWithTimeout(
      page.url,
      "text/html",
      TIMEOUT
    );

    diagnostic.status =
      "HTTP " + response.status;

    log(
      "HTML RESPONSE: " +
      response.status +
      " " + page.label
    );

    if (!response.ok) {
      return {
        urls: [],
        diagnostic: diagnostic
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
      diagnostic.status = "not_html";

      return {
        urls: [],
        diagnostic: diagnostic
      };
    }

    var size = Number(
      response.headers.get("content-length") || 0
    );

    if (size > MAX_HTML) {
      diagnostic.status = "html_too_large";

      return {
        urls: [],
        diagnostic: diagnostic
      };
    }

    var html = await response.text();

    if (html.length > MAX_HTML) {
      diagnostic.status = "html_too_large";

      return {
        urls: [],
        diagnostic: diagnostic
      };
    }

    if (
      /cf-chl-|just a moment|sprawdzamy połączenie|sorry, you have been blocked|direct access is prohibited|access denied/i
        .test(html)
    ) {
      diagnostic.status = "access_blocked";

      log("BLOCKED: " + page.label);

      return {
        urls: [],
        diagnostic: diagnostic
      };
    }

    var urls = extractFromHtml(
      html,
      page.url
    );

    diagnostic.count = urls.length;
    diagnostic.status =
      urls.length > 0
        ? "video_candidates"
        : "html_no_video";

    log(
      "HTML RESULT: " +
      diagnostic.status +
      " candidates=" + urls.length
    );

    return {
      urls: urls,
      diagnostic: diagnostic
    };
  } catch (error) {
    diagnostic.status =
      "fetch_error: " + errorText(error);

    log("HTML ERROR: " + diagnostic.status);

    return {
      urls: [],
      diagnostic: diagnostic
    };
  }
}

function makeStream(url, label, type) {
  return {
    name: "Strumyk Native " + type,
    title: label + " · " + type,
    quality: "Auto",
    url: url
  };
}

/*
 * Główna funkcja natywnego providera.
 * Nuvio przekazuje ID katalogu strumyk:...
 */
async function getStreams(
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
    return [];
  }

  /*
   * Zachowujemy sprawdzony test HLS.
   */
  if (id === "strumyk:test-hls") {
    log("TEST HLS SUCCESS");

    return [{
      name: "Strumyk Native TEST",
      title: "Big Buck Bunny · HLS 1080p",
      quality: "1080p",
      url: TEST_HLS
    }];
  }

  if (
    !/^strumyk:[A-Za-z0-9_-]{1,80}$/.test(id)
  ) {
    log("SKIP: not a Strumyk event");
    return [];
  }

  try {
    var sources = await loadWorkerStreams(id);
    var found = findVideoUrls(sources);

    log(
      "DIRECT=" + found.direct.length +
      " HTML=" + found.pages.length
    );

    var output = [];
    var seen = {};

    for (var i = 0; i < found.direct.length; i++) {
      var item = found.direct[i];

      if (seen[item.url]) continue;

      seen[item.url] = true;

      output.push(
        makeStream(
          item.url,
          item.label,
          item.type
        )
      );
    }

    /*
     * Skanujemy maksymalnie 4 jawnie
     * dostępne strony odtwarzaczy.
     */
    var pages = found.pages.slice(
      0,
      MAX_PAGES
    );

    for (var p = 0; p < pages.length; p++) {
      var result = await resolveHtmlPage(
        pages[p]
      );

      for (var j = 0; j < result.urls.length; j++) {
        var url = result.urls[j];

        if (seen[url]) continue;

        seen[url] = true;

        output.push(
          makeStream(
            url,
            pages[p].label,
            videoType(url) || "Video"
          )
        );
      }
    }

    log(
      "FINISH streams=" + output.length
    );

    /*
     * Nie dodajemy fikcyjnych źródeł.
     * Jeżeli nie ma jawnego HLS/MP4,
     * zwracamy pustą listę.
     */
    return output.slice(0, 30);
  } catch (error) {
    log("FAILED: " + errorText(error));
    return [];
  }
}

module.exports = {
  getStreams: getStreams
};
