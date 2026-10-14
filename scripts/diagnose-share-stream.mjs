#!/usr/bin/env node
// Bounded, read-only comparison. Prints timestamps and counters, never URLs or tokens.
import Database from "better-sqlite3";
import { monitorEventLoopDelay } from "node:perf_hooks";

const slug = process.argv[2];
const durationSeconds = Math.min(180, Math.max(15, Number(process.argv[3] || 120)));
if (!slug || !Number.isFinite(durationSeconds)) {
  console.error("Usage: node scripts/diagnose-share-stream.mjs <active-share-slug> [15-180 seconds]");
  process.exit(2);
}
const base = process.env.SHARETV_BASE_URL || "http://localhost:8080";
const databasePath = process.env.DATABASE_PATH || "data/app.sqlite";
const stamp = () => new Date().toISOString();
const report = (probe, event, fields = {}) => console.log(JSON.stringify({ at: stamp(), probe, event, ...fields }));
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const metadataResponse = await fetch(new URL(`/api/public/share/${encodeURIComponent(slug)}`, base));
if (!metadataResponse.ok) throw new Error(`Share API returned ${metadataResponse.status}`);
const { share } = await metadataResponse.json();
if (!share?.stream_available || !share.stream_url) throw new Error("Share is not currently streamable");

let upstreamUrl;
let sourceResolution = "share-channel";
if (share.kind === "static") {
  upstreamUrl = db.prepare(`SELECT channels.stream_url FROM static_share_events
    JOIN channels ON channels.id = static_share_events.channel_id
    JOIN static_shares ON static_shares.id = static_share_events.static_share_id
    WHERE static_shares.slug = ? AND static_share_events.id = ?`)
    .get(slug, share.active_event_id)?.stream_url;
} else if (share.active_program_id) {
  upstreamUrl = db.prepare(`SELECT channels.stream_url FROM epg_programs
    JOIN channels ON channels.id = epg_programs.channel_id WHERE epg_programs.id = ?`)
    .get(share.active_program_id)?.stream_url;
} else {
  upstreamUrl = db.prepare(`SELECT channels.stream_url FROM share_links
    JOIN channels ON channels.id = share_links.channel_id WHERE share_links.slug = ?`)
    .get(slug)?.stream_url;
}
if (!upstreamUrl && share.channel_name) {
  // A public deployment may use a different ShareTV database while consuming
  // the same Dispatcharr export. Require an unambiguous local channel name.
  const matches = db.prepare("SELECT stream_url FROM channels WHERE name = ? COLLATE NOCASE").all(share.channel_name);
  if (matches.length === 1) {
    upstreamUrl = matches[0].stream_url;
    sourceResolution = "matching-channel-name";
  }
}
db.close();
if (!upstreamUrl) throw new Error("Could not resolve upstream source from the local database");
const publicUrl = new URL(share.stream_url, base).toString();
const hlsUrl = share.hls_url ? new URL(share.hls_url, base).toString() : null;
let providerUrl = null;
if (process.argv.includes("--provider")) {
  const origin = new URL(process.env.DISPATCHARR_BASE_URL).origin;
  const auth = await fetch(new URL("/api/accounts/token/", origin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.DISPATCHARR_USERNAME, password: process.env.DISPATCHARR_PASSWORD }),
    signal: AbortSignal.timeout(10000),
  });
  if (!auth.ok) throw new Error(`Dispatcharr auth returned ${auth.status}`);
  const token = (await auth.json()).access;
  const channelResponse = await fetch(new URL(`/api/channels/channels/?search=${encodeURIComponent(share.channel_name)}&include_streams=true`, origin), {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  });
  if (!channelResponse.ok) throw new Error(`Dispatcharr channel lookup returned ${channelResponse.status}`);
  const channels = await channelResponse.json();
  const exact = (Array.isArray(channels) ? channels : channels.results || [])
    .filter(channel => channel.name.toLowerCase() === share.channel_name.toLowerCase());
  if (exact.length !== 1 || exact[0].streams?.length !== 1 || !exact[0].streams[0].url) {
    throw new Error("Could not uniquely resolve provider URL for this share channel");
  }
  providerUrl = exact[0].streams[0].url;
}
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
report("capture", "start", { durationSeconds, streamKind: share.stream_kind, hlsAvailable: !!hlsUrl, sourceResolution, providerAvailable: !!providerUrl });

function tsCounter(name) {
  let pending = Buffer.alloc(0);
  const ccByPid = new Map();
  const ptsByPid = new Map();
  const videoPids = new Set();
  let reportedPtsGaps = 0;
  let reportedPacketGaps = 0;
  const result = { packets: 0, syncLoss: 0, continuityGaps: 0, videoContinuityGaps: 0, videoPtsGaps: 0, videoPtsBackwards: 0, maxVideoPtsGapMs: 0, firstVideoPts: null, lastVideoPts: null };
  return {
    result,
    push(chunk) {
      pending = Buffer.concat([pending, chunk]);
      let offset = 0;
      while (pending.length - offset >= 188) {
        if (pending[offset] !== 0x47) { offset += 1; result.syncLoss += 1; continue; }
        const p = pending.subarray(offset, offset + 188);
        const pid = ((p[1] & 0x1f) << 8) | p[2];
        const adaptation = (p[3] >> 4) & 3;
        const hasPayload = adaptation === 1 || adaptation === 3;
        const discontinuity = adaptation === 2 || adaptation === 3 ? !!(p[5] & 0x80) : false;
        if (hasPayload && pid !== 0x1fff) {
          const cc = p[3] & 15;
          const previous = ccByPid.get(pid);
          if (previous !== undefined && cc !== ((previous + 1) & 15) && !discontinuity) {
            result.continuityGaps += 1;
            if (videoPids.has(pid)) {
              result.videoContinuityGaps += 1;
              if (reportedPacketGaps++ < 20) report(name, "video-packet-gap", { pid, expected: (previous + 1) & 15, actual: cc });
            }
          }
          ccByPid.set(pid, cc);
          const start = 4 + (adaptation === 3 ? 1 + p[4] : 0);
          if ((p[1] & 0x40) && start + 14 <= 188 && p[start] === 0 && p[start + 1] === 0 && p[start + 2] === 1 && (p[start + 3] & 0xf0) === 0xe0) {
            videoPids.add(pid);
            if (p[start + 7] & 0x80) {
              const b = p.subarray(start + 9, start + 14);
              const pts = (b[0] & 14) * 2 ** 29 + b[1] * 2 ** 22 + (b[2] & 254) * 2 ** 14 + b[3] * 2 ** 7 + (b[4] >> 1);
              if (result.firstVideoPts === null) result.firstVideoPts = pts;
              result.lastVideoPts = pts;
              const previousPts = ptsByPid.get(pid);
              if (previousPts !== undefined) {
                let delta = pts - previousPts;
                if (delta > 2 ** 32) delta -= 2 ** 33;
                if (delta < -(2 ** 32)) delta += 2 ** 33;
                const ms = delta / 90;
                if (ms > 500) { result.videoPtsGaps += 1; result.maxVideoPtsGapMs = Math.max(result.maxVideoPtsGapMs, Math.round(ms)); }
                if (ms < -100) result.videoPtsBackwards += 1;
                if ((ms > 500 || ms < -100) && reportedPtsGaps++ < 20) report(name, "video-pts-jump", { pid, deltaMs: Math.round(ms) });
              }
              ptsByPid.set(pid, pts);
            }
          }
        }
        result.packets += 1;
        offset += 188;
      }
      pending = pending.subarray(offset);
    },
  };
}

async function probeTransport(name, url, durationMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  const started = Date.now();
  const parser = tsCounter(name);
  let bytes = 0;
  let lastByteAt = started;
  let maxByteGapMs = 0;
  let gapsOver2s = 0;
  let status = null;
  let reason = "duration";
  let windowBytes = 0;
  let windowStartedAt = started;
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "iptv-share/0.2", Accept: "*/*" } });
    status = response.status;
    report(name, "response", { status, elapsedMs: Date.now() - started });
    if (!response.ok) { reason = `http-${status}`; return; }
    for await (const chunk of response.body) {
      const gap = Date.now() - lastByteAt;
      maxByteGapMs = Math.max(maxByteGapMs, gap);
      if (gap > 2000) { gapsOver2s += 1; report(name, "byte-gap", { gapMs: gap, bytes }); }
      lastByteAt = Date.now();
      bytes += chunk.length;
      windowBytes += chunk.length;
      if (Date.now() - windowStartedAt >= 5000) {
        report(name, "bytes", { windowMs: Date.now() - windowStartedAt, bytes: windowBytes });
        windowStartedAt = Date.now();
        windowBytes = 0;
      }
      parser.push(chunk);
    }
    reason = "eof";
  } catch (error) {
    reason = controller.signal.aborted ? "duration" : error.message;
  } finally {
    clearTimeout(timer);
    report(name, "end", { status, reason, elapsedMs: Date.now() - started, bytes, maxByteGapMs, gapsOver2s, ...parser.result });
  }
}

async function probeHls(url, durationMs) {
  const started = Date.now();
  let previousSequence = null;
  let previousDiscontinuities = null;
  let polls = 0;
  let failures = 0;
  while (Date.now() - started < durationMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const playlist = await response.text();
      const sequence = Number(playlist.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1] || 0);
      const discontinuities = Number(playlist.match(/^#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/m)?.[1] || 0) + (playlist.match(/^#EXT-X-DISCONTINUITY$/gm) || []).length;
      const segments = playlist.split(/\r?\n/).filter(line => line && !line.startsWith("#"));
      polls += 1;
      if (sequence !== previousSequence || discontinuities !== previousDiscontinuities) {
        report("hls", "playlist", { sequence, segments: segments.length, discontinuities });
      }
      previousSequence = sequence;
      previousDiscontinuities = discontinuities;
      if (segments.length) {
        const segment = await fetch(new URL(segments.at(-1), url), { signal: AbortSignal.timeout(15000) });
        if (!segment.ok) throw new Error(`Segment HTTP ${segment.status}`);
        await segment.arrayBuffer();
      }
    } catch (error) { failures += 1; report("hls", "error", { message: error.message }); }
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  report("hls", "end", { polls, failures, lastSequence: previousSequence, discontinuities: previousDiscontinuities });
}

await Promise.all(process.argv.includes("--upstream-only")
  ? [probeTransport("upstream", upstreamUrl, durationSeconds * 1000)]
  : [
      probeTransport("public-ts", publicUrl, durationSeconds * 1000),
      probeTransport("upstream", upstreamUrl, durationSeconds * 1000),
      ...(providerUrl ? [probeTransport("provider", providerUrl, durationSeconds * 1000)] : []),
      ...(hlsUrl ? [probeHls(hlsUrl, durationSeconds * 1000)] : []),
    ]);
eventLoopDelay.disable();
report("capture", "event-loop", { maxDelayMs: Math.round(eventLoopDelay.max / 1e6), meanDelayMs: Math.round(eventLoopDelay.mean / 1e6) });
