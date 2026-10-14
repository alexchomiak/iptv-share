#!/usr/bin/env node
// Run in the ShareTV container with an existing preview key in the environment.
// Secrets and signed URLs stay in memory. Output is sanitized JSON only.
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { proxyProgrammeArtwork, artworkErrorCategory } from '../src/server/programmeArtwork.js';

const slug = process.argv[2];
const base = process.env.SHARETV_BASE || process.env.SHARETV_BASE_URL;
const key = process.env.SHARETV_API_KEY;
const report = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
const safeRay = value => /^[a-f0-9]{16}-[A-Z]{3}$/.test(value || '') ? value : null;
const safeRequestId = value => /^[a-f0-9-]{36}$/.test(value || '') ? value : null;
function decodeImage(bytes) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'null', '-'], {
    input: bytes, timeout: 5000, maxBuffer: 1024 * 1024,
  });
  return result.error?.code === 'ENOENT' ? 'decoder-unavailable' : result.status === 0;
}
async function boundedBody(response, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('body-limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
try {
  if (!slug || !base || !key) throw new Error('configuration');
  const configured = new URL(base);
  if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password) throw new Error('configuration');
  const started = Date.now();
  const response = await fetch(new URL(`/api/integrations/discord/share/${encodeURIComponent(slug)}/preview`, configured), {
    headers: { 'X-API-Key': key }, redirect: 'error', signal: AbortSignal.timeout(1500),
  });
  report('preview_response', { status: response.status, elapsedMs: Date.now() - started, edgeTrace: safeRay(response.headers.get('cf-ray')) });
  if (!response.ok) { await response.body?.cancel(); process.exitCode = 1; }
  else {
    const { preview } = JSON.parse((await boundedBody(response, 65536)).toString());
    report('current_programme', { id: preview?.programme?.id || null, start_at: preview?.programme?.start_at || null, end_at: preview?.programme?.end_at || null });
    if (preview?.programme?.icon_url) {
      const imageUrl = new URL(preview.programme.icon_url);
      if (imageUrl.origin !== configured.origin || imageUrl.username || imageUrl.password ||
          !imageUrl.pathname.startsWith('/api/public/discord-programme-image/')) throw new Error('image-scope');
      const imageStart = Date.now();
      const image = await fetch(imageUrl, { redirect: 'error', signal: AbortSignal.timeout(1500) });
      const bytes = await boundedBody(image);
      const mime = image.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
      report('signed_image', { status: image.status, contentType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : null,
        elapsedMs: Date.now() - imageStart, bytes: bytes.length, decoded: image.ok && /^image\//.test(mime) ? decodeImage(bytes) : false,
        edgeTrace: safeRay(image.headers.get('cf-ray')), originRequestId: safeRequestId(image.headers.get('x-sharetv-artwork-request')) });
    }
    if (process.env.DATABASE_PATH && preview?.programme) {
      const db = new Database(process.env.DATABASE_PATH, { readonly: true, fileMustExist: true });
      const staticShare = db.prepare('SELECT id FROM static_shares WHERE slug = ?').get(slug);
      const row = staticShare
        ? db.prepare('SELECT icon FROM static_share_events WHERE static_share_id = ? AND id = ?').get(staticShare.id, preview.programme.id)
        : db.prepare(`SELECT p.icon FROM epg_programs p JOIN share_links s ON s.slug = ? WHERE p.id = ?
          AND ((s.mode != 'programs' AND p.channel_id = s.channel_id) OR
            (s.mode = 'programs' AND EXISTS (SELECT 1 FROM share_link_items i WHERE i.share_id = s.id AND i.program_id = p.id)))`).get(slug, preview.programme.id);
      db.close();
      if (row?.icon) {
        const chunks = [];
        let bytes = 0;
        const sink = new Writable({ write(chunk, _encoding, next) {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) return next(new Error('body-limit'));
          chunks.push(chunk); next();
        } });
        sink.statusCode = 200;
        sink.setHeader = () => {};
        await proxyProgrammeArtwork(sink, row.icon, { diagnostic: entry => report('origin_upstream', entry) });
        report('origin_decode', { status: sink.statusCode, bytes, decoded: sink.statusCode === 200 && !sink.errored ? decodeImage(Buffer.concat(chunks)) : false });
      } else report('origin_source_missing');
    }
  }
} catch (error) {
  const category = ['configuration', 'image-scope', 'body-limit'].includes(error.message) ? error.message : artworkErrorCategory(error, error.name === 'TimeoutError');
  report('diagnostic_failure', { category });
  process.exitCode = 1;
}
