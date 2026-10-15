import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import express from "express";
import { initIntegrationKeys, issueIntegrationKey, listIntegrationKeys, revokeIntegrationKey, authenticateIntegrationKey, publicImageUrl, sharePreview, discordPreviewRouter, previewScope } from "../src/server/discordPreview.js";

function fixture() {
  const db = new Database(":memory:");
  initIntegrationKeys(db);
  db.exec(`
    CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, logo TEXT, stream_url TEXT);
    CREATE TABLE share_links (id INTEGER PRIMARY KEY, slug TEXT, channel_id INTEGER, mode TEXT, starts_at INTEGER, ends_at INTEGER, password_hash TEXT);
    CREATE TABLE share_link_items (share_id INTEGER, program_id INTEGER);
    CREATE TABLE epg_programs (id INTEGER PRIMARY KEY, channel_id INTEGER, title TEXT, start_at INTEGER, end_at INTEGER, icon TEXT);
    CREATE TABLE static_shares (id INTEGER PRIMARY KEY, slug TEXT, password_hash TEXT);
    CREATE TABLE static_share_events (id INTEGER PRIMARY KEY, static_share_id INTEGER, channel_id INTEGER, title TEXT, starts_at INTEGER, ends_at INTEGER, icon TEXT);
    INSERT INTO channels VALUES (1, 'First', 'https://images.example/logo.jpg', 'https://source.example/secret'), (2, 'Second', NULL, 'https://source.example/password');
    INSERT INTO share_links VALUES (1, 'channel', 1, 'range', 100, 400, NULL), (2, 'programmes', 1, 'programs', 100, 400, NULL), (3, 'locked', 1, 'range', 100, 400, 'hash');
    INSERT INTO epg_programs VALUES (10, 1, 'Earlier', 100, 200, 'https://images.example/earlier.jpg'), (11, 1, 'Current', 200, 300, 'https://images.example/current.jpg'), (12, 2, 'Selected', 200, 300, 'https://images.example/selected.jpg');
    INSERT INTO share_link_items VALUES (2, 12);
    INSERT INTO static_shares VALUES (4, 'static', NULL), (5, 'static-locked', 'hash');
    INSERT INTO static_share_events VALUES (20, 4, 2, 'Static event', 200, 300, 'https://images.example/event.jpg');
    ALTER TABLE epg_programs ADD COLUMN description TEXT;
    ALTER TABLE static_share_events ADD COLUMN description TEXT;
  `);
  const options = {
    unlocked: (_kind, share) => !share.password_hash,
    activeProgram: () => ({ id: 12 }), activeEvent: () => ({ id: 20 }),
  };
  return { db, options, preview: (slug, current = 250, overrides = {}) => sharePreview(db, slug, current, { ...options, ...overrides }) };
}

test("keys are random, hashed, scoped, listed without secrets and immediately revocable", () => {
  const { db } = fixture();
  try {
    const first = issueIntegrationKey(db, 'Bot', 1, 100);
    const second = issueIntegrationKey(db, 'Other', 1, 101);
    assert.match(first.secret, /^stv_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first.secret, second.secret);
    assert.equal(first.key.scope, previewScope);
    const stored = db.prepare('SELECT * FROM integration_api_keys WHERE id = ?').get(first.key.id);
    assert.match(stored.key_hash, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(stored).includes(first.secret));
    assert.ok(!JSON.stringify(listIntegrationKeys(db)).includes('key_hash'));
    for (const secret of [undefined, '', 'wrong', `${first.secret}x`]) assert.equal(authenticateIntegrationKey(db, secret), false);
    assert.equal(authenticateIntegrationKey(db, first.secret), true);
    db.prepare('UPDATE integration_api_keys SET scope = ? WHERE id = ?').run('admin', second.key.id);
    assert.equal(authenticateIntegrationKey(db, second.secret), false);
    assert.equal(revokeIntegrationKey(db, first.key.id, 200), true);
    assert.equal(authenticateIntegrationKey(db, first.secret), false);
    revokeIntegrationKey(db, first.key.id, 300);
    assert.equal(listIntegrationKeys(db).find(k => k.id === first.key.id).revoked_at, 200);
    assert.equal(revokeIntegrationKey(db, 999, 300), false);
  } finally { db.close(); }
});

test("channel-only shares discover EPG without items and respect boundaries and channel scope", async () => {
  const { db, preview } = fixture();
  try {
    assert.deepEqual((await preview('channel', 200)).body, { preview: {
      channel_name: 'First', programme: { id: 11, title: 'Current', start_at: 200, end_at: 300, icon_url: 'https://images.example/current.jpg', description: null },
    } });
    assert.equal((await preview('channel', 199)).body.preview.programme.id, 10);
    assert.equal((await preview('channel', 300)).body.preview.programme, null);
    assert.equal((await preview('channel', 99)).body.preview.programme, null);
    db.prepare('DELETE FROM epg_programs WHERE channel_id = 1').run();
    assert.equal((await preview('channel')).body.preview.programme, null);
  } finally { db.close(); }
});

test("channel overlaps choose latest start then largest ID", async () => {
  const { db, preview } = fixture();
  try {
    db.exec(`INSERT INTO epg_programs (id, channel_id, title, start_at, end_at, icon) VALUES (13, 1, 'Overlap', 210, 290, NULL), (14, 1, 'Tie', 210, 290, NULL), (15, 1, 'Older', 205, 290, NULL)`);
    assert.equal((await preview('channel')).body.preview.programme.id, 14);
  } finally { db.close(); }
});

test("programme and static shares normalize the actual active item's channel and icon", async () => {
  const { db, preview } = fixture();
  try {
    assert.deepEqual((await preview('programmes')).body, { preview: { channel_name: 'Second', programme: {
      id: 12, title: 'Selected', start_at: 200, end_at: 300, icon_url: 'https://images.example/selected.jpg', description: null,
    } } });
    assert.deepEqual((await preview('static')).body, { preview: { channel_name: 'Second', programme: {
      id: 20, title: 'Static event', start_at: 200, end_at: 300, icon_url: 'https://images.example/event.jpg', description: null,
    } } });
    for (const slug of ['programmes', 'static']) {
      assert.equal((await preview(slug, 199)).body.preview.programme, null);
      assert.equal((await preview(slug, 300)).body.preview.programme, null);
    }
    assert.equal((await preview('programmes', 250, { activeProgram: () => ({ id: 11 }) })).body.preview.programme, null);
    assert.equal((await preview('static', 250, { activeEvent: () => ({ id: 999 }) })).body.preview.programme, null);
    assert.equal((await preview('static', 250, { activeEvent: () => null })).body.preview.programme, null);
  } finally { db.close(); }
});

test("missing artwork stays null and never substitutes a channel logo", async () => {
  const { db, preview } = fixture();
  try {
    db.exec("UPDATE epg_programs SET icon = NULL; UPDATE static_share_events SET icon = NULL;");
    for (const slug of ['channel', 'programmes', 'static']) assert.equal((await preview(slug)).body.preview.programme.icon_url, null);
  } finally { db.close(); }
});

test("unknown and expired temporary shares return 404, locked shares 403", async () => {
  const { db, preview } = fixture();
  try {
    assert.equal((await preview('missing')).status, 404);
    assert.equal((await preview('channel', 400)).status, 404);
    assert.equal((await preview('locked', 400)).status, 404);
    for (const slug of ['locked', 'static-locked']) assert.equal((await preview(slug)).status, 403);
    assert.equal((await preview('locked', 250, { unlocked: () => true })).status, 200);
  } finally { db.close(); }
});

test("artwork URLs are absolute public HTTP(S) upstream URLs without integration credentials", () => {
  assert.equal(publicImageUrl('https://images.example/a.jpg'), 'https://images.example/a.jpg');
  assert.equal(publicImageUrl('http://images.example/a.jpg'), 'http://images.example/a.jpg');
  for (const value of [null, '', '/api/program-image/1', 'file:///etc/passwd', 'data:image/png;base64,abc', 'ftp://images.example/a', 'https://user:secret@images.example/a', 'http://localhost/a', 'http://127.1/a', 'http://10.0.0.1/a', 'http://172.16.1.2/a', 'http://192.168.1.1/a', 'http://169.254.169.254/a', 'http://[::1]/a', 'http://server.local/a', 'https://images.example/a?api_key=secret']) assert.equal(publicImageUrl(value), null, String(value));
});

test("HTTP routes require admin sessions for issuance/revocation and preview-scoped keys for metadata only", async () => {
  const { db, options } = fixture();
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => {
    if (req.get('Cookie') !== 'admin-session=valid') return res.status(401).json({ error: 'unauthorized' });
    req.user = { id: 1 }; next();
  };
  app.use('/api', discordPreviewRouter({ db, requireAuth, now: () => 250,
    unlocked: (_req, kind, share) => options.unlocked(kind, share), activeProgram: options.activeProgram, activeEvent: options.activeEvent,
  }));
  app.get('/api/public/unchanged', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const admin = { Cookie: 'admin-session=valid', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/admin/integration-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Bot"}' })).status, 401);
    assert.equal((await fetch(`${base}/admin/integration-keys`, { method: 'POST', headers: admin, body: '{"name":""}' })).status, 400);
    const issuedResponse = await fetch(`${base}/admin/integration-keys`, { method: 'POST', headers: admin, body: '{"name":"Bot"}' });
    assert.equal(issuedResponse.status, 201);
    assert.equal(issuedResponse.headers.get('cache-control'), 'no-store');
    const issued = await issuedResponse.json();
    const headers = { 'X-API-Key': issued.secret };
    assert.equal((await fetch(`${base}/admin/integration-keys`, { headers })).status, 401);
    assert.equal((await fetch(`${base}/admin/integration-keys/${issued.key.id}`, { method: 'DELETE', headers })).status, 401);
    for (const key of [null, 'invalid']) {
      const response = await fetch(`${base}/integrations/discord/share/channel/preview`, { headers: key ? { 'X-API-Key': key } : admin });
      assert.equal(response.status, 401);
    }
    const response = await fetch(`${base}/integrations/discord/share/channel/preview`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ['preview']);
    assert.deepEqual(Object.keys(body.preview), ['channel_name', 'programme']);
    assert.deepEqual(Object.keys(body.preview.programme), ['id', 'title', 'start_at', 'end_at', 'icon_url', 'description']);
    assert.ok(!JSON.stringify(body).includes('stream_url'));
    assert.ok(!JSON.stringify(body).includes('source.example'));
    assert.ok(!JSON.stringify(body).includes(issued.secret));
    assert.equal((await fetch(`${base}/integrations/discord/share/locked/preview`, { headers })).status, 403);
    assert.equal((await fetch(`${base}/integrations/discord/share/missing/preview`, { headers })).status, 404);
    const listing = await (await fetch(`${base}/admin/integration-keys`, { headers: admin })).text();
    assert.ok(!listing.includes(issued.secret));
    assert.ok(!listing.includes('key_hash'));
    assert.equal((await fetch(`${base}/public/unchanged`)).headers.get('cache-control'), null);
    assert.equal((await fetch(`${base}/admin/integration-keys/${issued.key.id}`, { method: 'DELETE', headers: admin })).status, 204);
    assert.equal((await fetch(`${base}/integrations/discord/share/channel/preview`, { headers })).status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});

test("signed artwork is accessible without keys, bound to share/item/source, and expires", async () => {
  const { db, options } = fixture();
  const routeDiagnostics = [];
  const upstreamRequests = [];
  const upstream = express();
  upstream.get('/image', (req, res) => {
    upstreamRequests.push(req.headers);
    res.type('image/png').send(Buffer.from([137, 80, 78, 71]));
  });
  upstream.get('/redirect', (_req, res) => res.redirect('/image'));
  upstream.get('/not-image', (_req, res) => res.type('text/plain').send('not artwork'));
  const imageServer = upstream.listen(0, '127.0.0.1');
  await new Promise(resolve => imageServer.once('listening', resolve));
  const imageBase = `http://127.0.0.1:${imageServer.address().port}`;
  db.prepare('UPDATE epg_programs SET icon = ?').run(`${imageBase}/image`);
  db.prepare('UPDATE static_share_events SET icon = ?').run(`${imageBase}/image`);
  const issued = issueIntegrationKey(db, 'Bot', 1, 200);
  let current = 250;
  const app = express();
  app.use('/api', discordPreviewRouter({ db, requireAuth: (_req, res) => res.sendStatus(401), now: () => current,
    unlocked: (_req, kind, share) => options.unlocked(kind, share), activeProgram: options.activeProgram,
    activeEvent: options.activeEvent, imageSecret: 'image-signing-secret', artworkLogger: entry => routeDiagnostics.push(entry),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const preview = async slug => (await (await fetch(`${base}/api/integrations/discord/share/${slug}/preview`, { headers: { 'X-API-Key': issued.secret } })).json()).preview;
  try {
    const artwork = (await preview('channel')).programme.icon_url;
    assert.equal(new URL(artwork).origin, base);
    assert.ok(!artwork.includes(issued.secret));
    assert.ok(!artwork.includes(imageBase));
    for (const slug of ['channel', 'programmes', 'static']) {
      const url = (await preview(slug)).programme.icon_url;
      const image = await fetch(url, { headers: { 'cf-ray': 'a4a391c22ad19327-ORD' } });
      assert.equal(image.status, 200);
      assert.match(image.headers.get('x-sharetv-artwork-request'), /^[a-f0-9-]{36}$/);
      assert.equal(image.headers.get('content-type'), 'image/png');
      assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [137, 80, 78, 71]);
    }
    assert.equal(upstreamRequests.length, 3);
    assert.ok(routeDiagnostics.some(entry => entry.event === 'handler_start' && entry.edgeTrace === 'a4a391c22ad19327-ORD'));
    assert.ok(!JSON.stringify(routeDiagnostics).includes(issued.secret));
    assert.ok(!JSON.stringify(routeDiagnostics).includes(new URL(artwork).searchParams.get('signature')));
    for (const headers of upstreamRequests) {
      assert.equal(headers['x-api-key'], undefined);
      assert.equal(headers.cookie, undefined);
    }
    const unsigned = new URL(artwork); unsigned.searchParams.delete('signature');
    assert.equal((await fetch(unsigned)).status, 404);
    const tampered = new URL(artwork); tampered.searchParams.set('signature', 'f'.repeat(64));
    assert.equal((await fetch(tampered)).status, 404);
    assert.equal((await fetch(artwork.replace('/temporary/11', '/temporary/12'))).status, 404);
    assert.equal((await fetch(artwork.replace('/channel/', '/programmes/'))).status, 404);
    db.prepare('UPDATE epg_programs SET icon = ? WHERE id = 11').run(`${imageBase}/not-image`);
    assert.equal((await fetch(artwork)).status, 404);
    assert.equal((await fetch((await preview('channel')).programme.icon_url)).status, 502);
    db.prepare('UPDATE epg_programs SET icon = ? WHERE id = 11').run(`${imageBase}/redirect`);
    const redirectedImage = await fetch((await preview('channel')).programme.icon_url);
    assert.equal(redirectedImage.status, 200);
    await redirectedImage.arrayBuffer();
    db.prepare('UPDATE epg_programs SET icon = ? WHERE id = 11').run(`${imageBase}/image`);
    db.exec("UPDATE share_links SET password_hash = 'locked' WHERE slug = 'channel'");
    assert.equal((await fetch(artwork)).status, 404);
    db.exec("UPDATE share_links SET password_hash = NULL WHERE slug = 'channel'");
    db.exec("UPDATE share_links SET ends_at = 250 WHERE slug = 'channel'");
    assert.equal((await fetch(artwork)).status, 404);
    db.exec("UPDATE share_links SET ends_at = 400 WHERE slug = 'channel'");
    db.exec("UPDATE epg_programs SET channel_id = 2 WHERE id = 11");
    assert.equal((await fetch(artwork)).status, 404);
    db.exec("UPDATE epg_programs SET channel_id = 1 WHERE id = 11");
    const expired = new URL(artwork); expired.searchParams.set('expires', '250');
    assert.equal((await fetch(expired)).status, 404);
    current = 300;
    assert.equal((await fetch(artwork)).status, 404);
    current = 600;
    assert.equal((await fetch(artwork)).status, 404);
    assert.equal(upstreamRequests.length, 4);
  } finally {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => imageServer.close(resolve))]);
    db.close();
  }
});

test("all share types return their active item's full stored description without truncation", async () => {
  const { db, preview } = fixture();
  try {
    const longDescription = "A programme's full synopsis — with Unicode and line breaks.\n".repeat(8);
    const cases = [
      ['channel', 'epg_programs', 11, longDescription],
      ['programmes', 'epg_programs', 12, `Selected programme: ${longDescription}`],
      ['static', 'static_share_events', 20, `Scheduled event: ${longDescription}`],
    ];
    for (const [slug, table, id, description] of cases) {
      db.prepare(`UPDATE ${table} SET description = ? WHERE id = ?`).run(description, id);
      const result = (await preview(slug)).body.preview.programme;
      assert.equal(result.id, id);
      assert.equal(result.description, description);
      assert.ok(result.description.length > 128);
    }
  } finally { db.close(); }
});

test("missing descriptions are explicitly null for channel, programme and scheduled shares", async () => {
  const { db, preview } = fixture();
  try {
    for (const slug of ['channel', 'programmes', 'static']) {
      const result = (await preview(slug)).body.preview.programme;
      assert.ok(Object.hasOwn(result, 'description'));
      assert.equal(result.description, null);
    }
    db.prepare('UPDATE epg_programs SET description = ? WHERE id = 11').run('');
    assert.equal((await preview('channel')).body.preview.programme.description, '');
  } finally { db.close(); }
});

test("channel descriptions advance with the current EPG programme at its exact boundary", async () => {
  const { db, preview } = fixture();
  try {
    db.prepare('UPDATE epg_programs SET description = ? WHERE id = 10').run('Earlier programme synopsis');
    db.prepare('UPDATE epg_programs SET description = ? WHERE id = 11').run('Next programme synopsis');
    const earlier = (await preview('channel', 199)).body.preview.programme;
    assert.equal(earlier.id, 10);
    assert.equal(earlier.description, 'Earlier programme synopsis');
    const next = (await preview('channel', 200)).body.preview.programme;
    assert.equal(next.id, 11);
    assert.equal(next.description, 'Next programme synopsis');
    assert.equal((await preview('channel', 300)).body.preview.programme, null);
  } finally { db.close(); }
});
