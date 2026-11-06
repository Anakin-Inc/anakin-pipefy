const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../docs/anakin.js');

const DOCS = path.join(__dirname, '..', 'docs');

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

const noWait = { wait: async () => {}, intervalMs: 1, timeoutMs: 3 };

test('normalizeUrl keeps http(s), adds https, rejects the rest', () => {
  assert.equal(A.normalizeUrl(' https://a.com/x '), 'https://a.com/x');
  assert.equal(A.normalizeUrl('a.com/pricing'), 'https://a.com/pricing');
  for (const bad of ['', null, 'not a url', 'javascript:alert(1)', 'ftp://a.com', 'file:///etc/passwd', 'localhost']) {
    assert.equal(A.normalizeUrl(bad), null, String(bad));
  }
});

test('looksLikeApiKey accepts ask_ keys only', () => {
  assert.ok(A.looksLikeApiKey('ask_' + 'a1'.repeat(32)));
  assert.ok(A.looksLikeApiKey('  ask_' + 'a1'.repeat(32) + '\n'));
  for (const bad of ['', null, 'ask_', 'ak_live_abcdefghijklmnopqrst', 'some clipboard text', 'ask_abc def ghijklmnopqrstuvw']) {
    assert.equal(A.looksLikeApiKey(bad), false, String(bad));
  }
});

test('findCardUrl returns the first full URL value', () => {
  assert.equal(A.findCardUrl({ field_values: { a: 'text', b: 5, c: ' https://x.io/p ', d: 'https://y.io' } }), 'https://x.io/p');
  assert.equal(A.findCardUrl({ field_values: { a: 'see https://x.io for more' } }), '');
  assert.equal(A.findCardUrl({}), '');
  assert.equal(A.findCardUrl(null), '');
});

test('longTextFields matches both type spellings', () => {
  const fields = [
    { id: 'a', type: 'long_text' },
    { id: 'b', type: 'LongText' },
    { id: 'c', type: 'short_text' },
    { id: 'd', type: 'Statement' },
    { id: 'e' },
  ];
  assert.deepEqual(A.longTextFields(fields).map((f) => f.id), ['a', 'b']);
  assert.deepEqual(A.longTextFields(null), []);
});

test('graphqlErrorMessage handles an array and a single error', () => {
  assert.equal(A.graphqlErrorMessage([{ message: 'a' }, { message: 'b' }]), 'a; b');
  assert.equal(A.graphqlErrorMessage(new Error('boom')), 'boom');
  assert.equal(A.graphqlErrorMessage('Error: raw'), 'Error: raw');
  assert.equal(A.graphqlErrorMessage(undefined), '');
});

test('scrape submits then polls until completed, sending only X-API-Key', async () => {
  const fetchFn = fakeFetch([
    { status: 202, body: { jobId: 'j/1', status: 'pending' } },
    { status: 200, body: { status: 'processing' } },
    { status: 200, body: { status: 'completed', markdown: '# Hi' } },
  ]);
  const job = await A.scrape(fetchFn, 'ask_k', 'https://a.com', noWait);
  assert.equal(job.markdown, '# Hi');
  assert.equal(fetchFn.calls[0].url, 'https://api.anakin.io/v1/url-scraper');
  assert.equal(fetchFn.calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(fetchFn.calls[0].options.body), { url: 'https://a.com' });
  assert.equal(fetchFn.calls[1].url, 'https://api.anakin.io/v1/url-scraper/j%2F1');
  // Anything outside the API's CORS allow-list fails the browser preflight.
  const allowed = new Set(['x-api-key', 'content-type']);
  for (const call of fetchFn.calls) {
    for (const header of Object.keys(call.options.headers)) assert.ok(allowed.has(header.toLowerCase()), header);
  }
});

test('scrape surfaces a failed job', async () => {
  const fetchFn = fakeFetch([
    { status: 202, body: { jobId: 'j' } },
    { status: 200, body: { status: 'failed', error: 'blocked by site' } },
  ]);
  await assert.rejects(A.scrape(fetchFn, 'k', 'https://a.com', noWait), /blocked by site/);
});

test('scrape stops polling at the deadline', async () => {
  const responses = [{ status: 202, body: { jobId: 'j' } }];
  for (let i = 0; i < 20; i++) responses.push({ status: 200, body: { status: 'processing' } });
  const fetchFn = fakeFetch(responses);
  await assert.rejects(A.scrape(fetchFn, 'k', 'https://a.com', noWait), (e) => e.code === 'timeout');
  assert.ok(fetchFn.calls.length <= 5);
});

test('HTTP errors carry status and the API message; non-JSON bodies do not crash', async () => {
  await assert.rejects(
    A.verifyKey(fakeFetch([{ status: 401, body: { error: 'unauthorized', message: 'Invalid or inactive API key' } }]), 'k'),
    (e) => e.status === 401 && e.code === 'unauthorized'
  );
  await assert.rejects(A.scrape(fakeFetch([{ status: 502, body: '<html>bad gateway</html>' }]), 'k', 'https://a.com', noWait), (e) => e.status === 502);
});

test('friendlyError never returns an empty message and maps network failures', () => {
  assert.match(A.friendlyError(new TypeError('Failed to fetch')), /Could not reach Anakin/);
  assert.match(A.friendlyError(new A.ApiError('x', 401)), /rejected this API key/);
  assert.match(A.friendlyError(new A.ApiError('No credits.', 402)), /No credits\..*dashboard/);
  assert.match(A.friendlyError(new A.ApiError('x', 429)), /Too many/);
  assert.equal(A.friendlyError(new A.ApiError('site blocked', 200)), 'site blocked');
});

test('manifest meets the publishing checklist', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DOCS, 'manifest.json'), 'utf8'));
  for (const key of ['name', 'short_description', 'description', 'icon', 'author', 'init_url']) {
    assert.ok(manifest[key], key);
  }
  assert.ok(manifest.screenshots.length >= 1);
  for (const asset of [manifest.icon, manifest.init_url, ...manifest.screenshots]) {
    assert.ok(fs.existsSync(path.join(DOCS, asset)), 'missing ' + asset);
  }
});

test('every manifest feature has a handler, and every handler is declared', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DOCS, 'manifest.json'), 'utf8'));
  let handlers;
  const source = fs.readFileSync(path.join(DOCS, 'init.js'), 'utf8');
  new Function('PipefyApp', source)({ initCall: (h) => (handlers = h) });
  assert.deepEqual(Object.keys(handlers).sort(), [...manifest.features].sort());

  const tab = handlers['card-tab']();
  assert.ok(tab.title && fs.existsSync(path.join(DOCS, tab.url)) && fs.existsSync(path.join(DOCS, tab.icon)));
  const [button] = handlers['card-buttons']();
  assert.ok(button.text && fs.existsSync(path.join(DOCS, button.icon)));
  let opened;
  button.callback({ modal: (o) => (opened = o) });
  assert.ok(fs.existsSync(path.join(DOCS, opened.url)));
});

test('the UI never renders untrusted text as HTML', () => {
  const source = fs.readFileSync(path.join(DOCS, 'ui.js'), 'utf8');
  assert.doesNotMatch(source, /\.innerHTML|insertAdjacentHTML|document\.write/);
});

test('the API key is only stored with private visibility and is never logged', () => {
  const source = fs.readFileSync(path.join(DOCS, 'ui.js'), 'utf8');
  const uses = source.match(/p\.(set|get)\('[a-z]+', '[a-z]+', KEY_NAME/g);
  assert.ok(uses.length >= 2);
  for (const use of uses) assert.match(use, /'private'/);
  assert.doesNotMatch(source, /console\./);
});

test('every asset the manifest references exists and is not empty', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DOCS, 'manifest.json'), 'utf8'));
  for (const asset of [manifest.icon, manifest.init_url, ...manifest.screenshots]) {
    assert.ok(fs.statSync(path.join(DOCS, asset)).size > 0, asset + ' is empty');
  }
});
