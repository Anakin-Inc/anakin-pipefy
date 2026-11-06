/*
 * Anakin REST client and the pure helpers behind the UI. No DOM and no Pipefy
 * SDK in here, so it runs unchanged under `node --test`.
 *
 * The browser calls api.anakin.io directly: it answers CORS with
 * `Access-Control-Allow-Origin: *` and allows X-API-Key. Do not add custom
 * headers such as X-Source, because they are not on the API's CORS allow-list
 * and the browser would fail the preflight.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AnakinPipefy = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var API_BASE = 'https://api.anakin.io/v1';
  var POLL_INTERVAL_MS = 2000;
  var POLL_TIMEOUT_MS = 120000;

  function ApiError(message, status, code) {
    this.name = 'ApiError';
    this.message = message;
    this.status = status;
    this.code = code;
  }
  ApiError.prototype = Object.create(Error.prototype);

  /** Returns the normalized http(s) URL, or null when the input isn't one. */
  function normalizeUrl(input) {
    var value = String(input == null ? '' : input).trim();
    if (!value) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = 'https://' + value;
    try {
      var parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      if (parsed.hostname.indexOf('.') === -1) return null;
      return parsed.href;
    } catch (e) {
      return null;
    }
  }

  /** Format check only, done before a value is ever sent over the network. */
  function looksLikeApiKey(input) {
    return /^ask_[A-Za-z0-9]{16,}$/.test(String(input == null ? '' : input).trim());
  }

  /** First value on the card that is a full http(s) URL, or ''. */
  function findCardUrl(card) {
    var values = (card && card.field_values) || {};
    var keys = Object.keys(values);
    for (var i = 0; i < keys.length; i++) {
      var value = values[keys[i]];
      if (typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim())) {
        return value.trim();
      }
    }
    return '';
  }

  /** Long text fields only. The docs show both `long_text` and `Statement`-style type names. */
  function longTextFields(fields) {
    return (fields || []).filter(function (field) {
      return String(field.type || '').toLowerCase().replace(/[^a-z]/g, '') === 'longtext';
    });
  }

  function formatForCard(url, markdown, now) {
    return 'Source: ' + url + '\nScraped: ' + now.toISOString() + '\n\n' + markdown;
  }

  /** Reads a GraphQL `errors` value, which Pipefy returns as an array or a single Error. */
  function graphqlErrorMessage(errors) {
    if (!errors) return '';
    var list = Array.isArray(errors) ? errors : [errors];
    return list
      .map(function (e) {
        return (e && e.message) || String(e);
      })
      .join('; ');
  }

  function friendlyError(error) {
    if (!(error instanceof ApiError)) {
      return 'Could not reach Anakin. Check your connection and try again.';
    }
    if (error.status === 401) return 'Anakin rejected this API key. Update it and try again.';
    if (error.status === 402) return error.message + ' Check your plan at https://anakin.io/dashboard.';
    if (error.status === 429) return 'Too many requests to Anakin. Wait a moment and try again.';
    return error.message;
  }

  function request(fetchFn, apiKey, method, path, body) {
    var options = { method: method, headers: { 'X-API-Key': apiKey } };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetchFn(API_BASE + path, options).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          data = null;
        }
        if (!response.ok) {
          var message = (data && data.message) || 'Anakin returned HTTP ' + response.status + '.';
          throw new ApiError(message, response.status, data && data.error);
        }
        return data;
      });
    });
  }

  /**
   * GET /v1/monitors, because it answers 401 for a bad key. The scrape endpoints
   * have a keyless tier, so they can't prove that a key is valid.
   */
  function verifyKey(fetchFn, apiKey) {
    return request(fetchFn, apiKey, 'GET', '/monitors').then(function () {
      return true;
    });
  }

  /** Submits a scrape and polls until it finishes. Resolves to the completed job. */
  function scrape(fetchFn, apiKey, url, opts) {
    var options = opts || {};
    var wait =
      options.wait ||
      function (ms) {
        return new Promise(function (resolve) {
          setTimeout(resolve, ms);
        });
      };
    var interval = options.intervalMs == null ? POLL_INTERVAL_MS : options.intervalMs;
    var attempts = Math.ceil((options.timeoutMs || POLL_TIMEOUT_MS) / Math.max(interval, 1));

    return request(fetchFn, apiKey, 'POST', '/url-scraper', { url: url }).then(function (submitted) {
      var jobId = submitted && (submitted.jobId || submitted.id);
      if (!jobId) throw new ApiError('Anakin did not return a job ID.', 500);

      function poll(remaining) {
        return request(fetchFn, apiKey, 'GET', '/url-scraper/' + encodeURIComponent(jobId)).then(function (job) {
          if (job.status === 'completed') return job;
          if (job.status === 'failed') {
            throw new ApiError(job.error || job.message || 'Anakin could not scrape this page.', 200, 'job_failed');
          }
          if (remaining <= 0) {
            throw new ApiError('This page is taking too long to scrape. Try again in a minute.', 408, 'timeout');
          }
          return wait(interval).then(function () {
            return poll(remaining - 1);
          });
        });
      }
      return poll(attempts);
    });
  }

  return {
    ApiError: ApiError,
    normalizeUrl: normalizeUrl,
    looksLikeApiKey: looksLikeApiKey,
    findCardUrl: findCardUrl,
    longTextFields: longTextFields,
    formatForCard: formatForCard,
    graphqlErrorMessage: graphqlErrorMessage,
    friendlyError: friendlyError,
    verifyKey: verifyKey,
    scrape: scrape,
  };
});
