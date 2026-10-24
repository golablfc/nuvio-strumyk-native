
/*
 * Strumyk Native Bridge v0.1.0
 * Natywny provider JavaScript dla Nuvio
 *
 * Test kompatybilnosci z identyfikatorami
 * strumyk:... z naszego katalogu Cloudflare.
 */

var WORKER =
  'https://strumyk-stremio-addon.karotu1994.workers.dev';

var TEST_HLS =
  'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

function getStreams(
  tmdbId,
  mediaType,
  season,
  episode
) {
  var id = String(
    tmdbId == null ? '' : tmdbId
  ).trim();

  console.log(
    '[StrumykBridge] getStreams id=' +
    id +
    ' type=' +
    mediaType
  );

  if (mediaType !== 'movie') {
    return Promise.resolve([]);
  }

  // Publiczny test HLS.
  // Zadziała, jeśli Nuvio przekazuje
  // identyfikatory naszego katalogu.

  if (id === 'strumyk:test-hls') {
    return Promise.resolve([
      {
        name: 'Strumyk Native TEST',
        title: 'Big Buck Bunny - publiczny HLS',
        quality: '1080p',
        url: TEST_HLS
      }
    ]);
  }

  // Provider obsluguje tylko wydarzenia Strumyk.
  // Nie podmieniamy strumieni normalnych filmow.

  if (
    !/^strumyk:[A-Za-z0-9_-]{1,80}$/.test(id)
  ) {
    console.log(
      '[StrumykBridge] ID spoza katalogu Strumyk'
    );

    return Promise.resolve([]);
  }

  var endpoint =
    WORKER +
    '/stream/movie/' +
    encodeURIComponent(id) +
    '.json';

  console.log(
    '[StrumykBridge] Pobieram: ' + endpoint
  );

  return fetch(endpoint)
    .then(function(response) {
      if (!response.ok) {
        throw new Error(
          'Worker HTTP ' + response.status
        );
      }

      return response.json();
    })
    .then(function(data) {
      var rows =
        data && Array.isArray(data.streams)
          ? data.streams
          : [];

      var result = [];

      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];

        if (
          !row ||
          typeof row.url !== 'string'
        ) {
          continue;
        }

        var url = row.url;

        // Przyjmujemy tylko bezposrednie
        // adresy materialow wideo.
        // Pomijamy strony HTML i externalUrl.

        if (
          !/^https:\/\//i.test(url) ||
          !/\.(m3u8|mp4|m4v|webm)(?:[?#]|$)/i
            .test(url)
        ) {
          continue;
        }

        result.push({
          name: 'Strumyk Native',
          title: String(
            row.title ||
            row.name ||
            'Video'
          ),
          quality: 'Auto',
          url: url
        });
      }

      console.log(
        '[StrumykBridge] Zrodla video: ' +
        result.length
      );

      return result;
    })
    .catch(function(error) {
      console.log(
        '[StrumykBridge] Blad: ' +
        String(
          error && error.message || error
        )
      );

      return [];
    });
}

module.exports = {
  getStreams: getStreams
};
