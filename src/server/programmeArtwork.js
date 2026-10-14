import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) privateAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96], ['::1', 128], ['::ffff:0:0', 96], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8], ['2001:db8::', 32],
]) privateAddresses.addSubnet(address, prefix, 'ipv6');

class ArtworkError extends Error {
  constructor(category) { super(category); this.category = category; }
}

export function artworkErrorCategory(error, timedOut = false, disconnected = false) {
  if (timedOut) return 'timeout';
  if (disconnected) return 'client_disconnected';
  if (error instanceof ArtworkError) return error.category;
  const code = error?.code || error?.cause?.code || '';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns';
  if (/CERT|TLS|SSL|VERIFY_LEAF/.test(code)) return 'tls';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code)) return 'socket';
  return 'body_or_transport';
}

export function sanitizedArtworkSource(value) {
  try {
    const url = new URL(value);
    let redactNext = false;
    const path = url.pathname.split('/').map(segment => {
      const sensitive = redactNext || segment.length > 32 || /^[a-f0-9]{24,}$/i.test(segment) || /%[a-f0-9]{2}/i.test(segment);
      redactNext = /^(token|key|password|credentials|signature|auth)$/i.test(segment);
      return sensitive ? '[redacted]' : segment;
    }).join('/').slice(0, 160);
    return { hostname: url.hostname, path };
  } catch { return { hostname: null, path: null }; }
}

function sourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ArtworkError('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ArtworkError('invalid_url');
  url.hash = '';
  return url;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function requestImage(url, trustedOrigin, signal, lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }]
    : await abortable(lookup(host, { all: true }), signal);
  if (!addresses.length) throw new ArtworkError('dns');
  // The original stored origin may be an internal EPG image service. Redirects
  // may remain there, but cannot introduce another private/local destination.
  if (url.origin !== trustedOrigin && addresses.some(({ address, family }) =>
    privateAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4'))) throw new ArtworkError('unsafe_redirect');
  const pinned = addresses.find(item => item.family === 4) || addresses[0];
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', signal,
      headers: { Accept: 'image/*', 'User-Agent': 'ShareTV programme artwork/1.0' },
      // Pin the validated address. A second DNS lookup must not bypass policy.
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
    }, resolve);
    request.on('error', reject);
    request.end();
  });
}

export async function proxyProgrammeArtwork(res, source, { diagnostic = () => {}, timeoutMs = 1500, lookup = dnsLookup } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  let disconnected = false;
  let upstream;
  let upstreamError;
  let bytes = 0;
  const report = (event, fields = {}) => diagnostic({ event, elapsedMs: Date.now() - started, ...fields });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timer.unref();
  const onClose = () => {
    if (!res.writableFinished) {
      disconnected = !upstream?.destroyed;
      controller.abort();
    }
  };
  res.once('close', onClose);
  try {
    let url = sourceUrl(source);
    const trustedOrigin = url.origin;
    const visited = new Set();
    for (let hop = 0; ; hop += 1) {
      if (visited.has(url.href)) throw new ArtworkError('redirect_loop');
      visited.add(url.href);
      report('upstream_start', { hop, source: sanitizedArtworkSource(url) });
      upstream = await requestImage(url, trustedOrigin, controller.signal, lookup);
      upstreamError = null;
      upstream.on('error', error => { upstreamError = error; });
      const status = upstream.statusCode;
      const contentType = String(upstream.headers['content-type'] || '');
      const mime = contentType.split(';')[0].trim().toLowerCase();
      report('upstream_response', { hop, status, contentType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : null });
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = upstream.headers.location;
        upstream.destroy();
        if (hop >= 3) throw new ArtworkError('redirect_limit');
        if (!location) throw new ArtworkError('invalid_redirect');
        let next;
        try { next = sourceUrl(new URL(location, url)); } catch { throw new ArtworkError('invalid_redirect'); }
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw new ArtworkError('unsafe_redirect');
        report('redirect', { hop, status, target: sanitizedArtworkSource(next) });
        url = next;
        continue;
      }
      if (status < 200 || status >= 300) throw new ArtworkError('upstream_status');
      if (!/^image\/[a-z0-9.+-]+$/.test(mime)) throw new ArtworkError('non_image');
      const iterator = upstream[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || !first.value.length) throw new ArtworkError('empty_body');
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      const body = Readable.from((async function* () {
        bytes += first.value.length;
        yield first.value;
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
          bytes += chunk.length;
          yield chunk;
        }
      })());
      await pipeline(body, res, { signal: controller.signal });
      report('complete', { status: 200, bytes });
      break;
    }
  } catch (error) {
    report('failure', { category: artworkErrorCategory(upstreamError || error, timedOut, disconnected), bytes, headersSent: res.headersSent });
    if (!res.headersSent && !res.destroyed) { res.statusCode = 502; res.end(); }
    else if (!res.destroyed) res.destroy();
  } finally {
    clearTimeout(timer);
    res.removeListener('close', onClose);
    controller.abort();
    upstream?.destroy();
  }
}
