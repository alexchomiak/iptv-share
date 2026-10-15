import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inflateSync } from 'node:zlib';
import { proxyProgrammeArtwork, sanitizedArtworkSource, artworkErrorCategory, artworkRedirectTarget } from '../src/server/programmeArtwork.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function servers(t, { timeoutMs = 1500, lookup } = {}) {
  const requests = [];
  const diagnostics = [];
  const timers = new Set();
  let source;
  let completion;
  const upstream = http.createServer((req, res) => {
    requests.push({ path: req.url.split('?')[0], headers: req.headers });
    const path = req.url.split('?')[0];
    if (path === '/image' || path === '/images/version/image') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
    if (path === '/images/image') return res.writeHead(302, { Location: '/images/version/image', 'Set-Cookie': 'upstream-secret=private' }).end();
    if (path === '/loop') return res.writeHead(302, { Location: '/loop' }).end();
    if (path.startsWith('/chain/')) return res.writeHead(302, { Location: `/chain/${Number(path.split('/').at(-1)) + 1}` }).end();
    if (path === '/credentials') return res.writeHead(302, { Location: 'http://user:secret@evil.example/image' }).end();
    if (path === '/scheme') return res.writeHead(302, { Location: 'file:///etc/passwd' }).end();
    if (path === '/private') return res.writeHead(302, { Location: 'http://169.254.169.254/image' }).end();
    if (path === '/private-dns') return res.writeHead(302, { Location: 'http://evil.example/image' }).end();
    if (path === '/missing-location') return res.writeHead(302).end();
    if (path === '/not-image') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>denied</html>');
    if (path === '/missing-type') return res.writeHead(200).end(png);
    if (path === '/denied') return res.writeHead(403).end('denied');
    if (path === '/missing') return res.writeHead(404).end('missing');
    if (path === '/empty') return res.writeHead(200, { 'Content-Type': 'image/png' }).end();
    if (path === '/socket-error') return res.destroy();
    if (path === '/body-error') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length + 200 });
      res.write(png);
      const timer = setTimeout(() => res.destroy(), 30); timers.add(timer);
      return;
    }
    if (path === '/slow-body') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.write(png.subarray(0, 8));
      return;
    }
    if (path === '/slow-redirect' || path === '/slow-image') {
      const timer = setTimeout(() => {
        if (path === '/slow-redirect') res.writeHead(302, { Location: '/slow-image' }).end();
        else res.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
      }, 70);
      timers.add(timer);
      return;
    }
    if (path === '/hang') return;
    res.writeHead(404).end();
  });
  upstream.listen(0, '127.0.0.1');
  await new Promise(resolve => upstream.once('listening', resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const origin = http.createServer((_req, res) => {
    completion = proxyProgrammeArtwork(res, source, {
      timeoutMs, lookup, diagnostic: entry => diagnostics.push(entry),
    });
  });
  origin.listen(0, '127.0.0.1');
  await new Promise(resolve => origin.once('listening', resolve));
  const base = `http://127.0.0.1:${origin.address().port}`;
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    await Promise.all([upstream, origin].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  });
  return { requests, diagnostics, base, upstreamBase, request: (path, headers = {}) => {
    source = `${upstreamBase}${path}`;
    return fetch(base, { headers });
  }, setSource: value => { source = value; }, waitComplete: () => completion };
}

test('serves real image bytes and follows the evidenced same-origin 302 without credentials', async t => {
  const { request, requests, diagnostics } = await servers(t);
  for (const path of ['/image', '/images/image']) {
    const response = await request(path, { 'X-API-Key': 'integration-secret', Cookie: 'private-cookie', Authorization: 'Bearer private-token' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const result = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(result, png);
    assert.equal(result.readUInt32BE(16), 1); // Actual PNG IHDR width and height.
    assert.equal(result.readUInt32BE(20), 1);
    const index = result.indexOf(Buffer.from('IDAT'));
    assert.ok(inflateSync(result.subarray(index + 4, index + 4 + result.readUInt32BE(index - 4))).length > 0);
  }
  assert.equal(requests.length, 3);
  for (const { headers } of requests) {
    assert.equal(headers['x-api-key'], undefined);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.authorization, undefined);
  }
  assert.ok(diagnostics.some(entry => entry.event === 'redirect' && entry.status === 302));
  assert.ok(!JSON.stringify(diagnostics).includes('integration-secret'));
});

test('redirects reject loops, excessive hops, credentials, schemes and new private destinations', async t => {
  const { request, requests, diagnostics } = await servers(t, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  for (const [path, category] of [
    ['/loop', 'redirect_loop'], ['/chain/0', 'redirect_limit'], ['/credentials', 'invalid_redirect'],
    ['/scheme', 'invalid_redirect'], ['/private', 'unsafe_redirect'], ['/private-dns', 'unsafe_redirect'],
    ['/missing-location', 'invalid_redirect'],
  ]) {
    const response = await request(path);
    assert.equal(response.status, 502, path);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal(diagnostics.at(-1).category, category);
  }
  assert.equal(requests.filter(req => req.path.startsWith('/chain/')).length, 4);
  assert.ok(!requests.some(req => req.headers.host === 'evil.example'));
});

test('non-image, missing type, non-2xx and empty body fail before sending image headers', async t => {
  const { request, diagnostics } = await servers(t);
  for (const [path, category] of [
    ['/not-image', 'non_image'], ['/missing-type', 'non_image'], ['/denied', 'upstream_status'],
    ['/missing', 'upstream_status'], ['/empty', 'empty_body'],
  ]) {
    const response = await request(path);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('content-type'), null);
    await response.arrayBuffer();
    assert.equal(diagnostics.at(-1).category, category);
  }
});

test('one total timeout covers response headers and every redirect hop', async t => {
  const { request, diagnostics } = await servers(t, { timeoutMs: 100 });
  for (const path of ['/hang', '/slow-redirect']) {
    const started = Date.now();
    const response = await request(path);
    assert.equal(response.status, 502);
    await response.arrayBuffer();
    assert.equal(diagnostics.at(-1).category, 'timeout');
    assert.ok(Date.now() - started < 400);
  }
});

test('timeout and upstream body/socket failures terminate streaming and clean up', async t => {
  const { request, diagnostics, waitComplete } = await servers(t, { timeoutMs: 100 });
  assert.equal((await request('/socket-error')).status, 502);
  assert.equal(diagnostics.at(-1).category, 'socket');
  for (const [path, category] of [['/body-error', 'socket'], ['/slow-body', 'timeout']]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    await assert.rejects(response.arrayBuffer());
    await waitComplete();
    assert.equal(diagnostics.at(-1).category, category);
    assert.equal(diagnostics.at(-1).headersSent, true);
  }
});

test('client disconnect aborts the upstream body', async t => {
  const { base, upstreamBase, setSource, diagnostics } = await servers(t);
  setSource(`${upstreamBase}/slow-body`);
  await new Promise((resolve, reject) => {
    const request = http.get(base, response => {
      response.once('data', () => { response.destroy(); resolve(); });
      response.on('error', () => {});
    });
    request.on('error', reject);
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(diagnostics.at(-1).category, 'client_disconnected');
});

test('diagnostics omit query strings, credentials, opaque path segments and raw error messages', () => {
  assert.deepEqual(sanitizedArtworkSource('https://images.example/images/' + 'a'.repeat(60) + '?api_key=secret&signature=private'), {
    hostname: 'images.example', path: '/images/[redacted]',
  });
  assert.deepEqual(sanitizedArtworkSource('https://images.example/token/secret/image'), { hostname: 'images.example', path: '/token/[redacted]/image' });
  assert.equal(artworkErrorCategory({ code: 'ENOTFOUND', message: 'secret' }), 'dns');
  assert.equal(artworkErrorCategory({ code: 'CERT_HAS_EXPIRED', message: 'secret' }), 'tls');
});

test('HTTPS redirects allow valid targets and reject downgrades and URL credentials', () => {
  assert.equal(artworkRedirectTarget('/image', 'https://images.example/start').href, 'https://images.example/image');
  assert.equal(artworkRedirectTarget('https://cdn.example/image', 'https://images.example/start').href, 'https://cdn.example/image');
  assert.throws(() => artworkRedirectTarget('http://images.example/image', 'https://images.example/start'), { message: 'unsafe_redirect' });
  assert.throws(() => artworkRedirectTarget('https://user:secret@images.example/image', 'https://images.example/start'), { message: 'invalid_redirect' });
});

test('a stalled DNS lookup respects the same total timeout without opening a socket', async t => {
  const { base, setSource, diagnostics, requests } = await servers(t, { timeoutMs: 50, lookup: () => new Promise(() => {}) });
  setSource('http://slow.example/image');
  const response = await fetch(base);
  assert.equal(response.status, 502);
  assert.equal(diagnostics.at(-1).category, 'timeout');
  assert.equal(requests.length, 0);
});
