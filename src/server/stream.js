import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { safeCompare, signedShareCookie, signStreamTarget } from "./crypto.js";

const hlsSessions = new Map();
const hlsSessionsById = new Map();
const hlsSessionStarts = new Map();

export function shareIsUnlocked(req, share) {
  if (!share.password_hash) return true;
  return safeCompare(req.cookies[`share_${share.id}`], signedShareCookie(share.id));
}

export function shareIsStreamable(share) {
  const current = Math.floor(Date.now() / 1000);
  return share.starts_at - config.streamGraceSeconds <= current && current <= share.ends_at + config.streamGraceSeconds;
}

export function encodeTarget(value) {
  return Buffer.from(value).toString("base64url");
}

export function decodeTarget(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function proxiedUrl(slug, targetUrl, extraParams = {}) {
  const encoded = encodeTarget(targetUrl);
  const sig = signStreamTarget(slug, targetUrl);
  const params = new URLSearchParams({ u: encoded, sig });
  for (const [key, value] of Object.entries(extraParams)) {
    if (key !== "route" && value) params.set(key, value);
  }
  return `${extraParams.route || "/api/public/stream"}/${encodeURIComponent(slug)}?${params.toString()}`;
}

function rewriteHlsAttributeUris(line, baseUrl, slug, extraParams) {
  return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
    const target = new URL(uri, baseUrl).toString();
    return `URI="${proxiedUrl(slug, target, extraParams)}"`;
  });
}

export function rewriteHlsPlaylist(text, baseUrl, slug, extraParams = {}) {
  return `${text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        return proxiedUrl(slug, new URL(trimmed, baseUrl).toString(), extraParams);
      }
      if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
        return rewriteHlsAttributeUris(line, baseUrl, slug, extraParams);
      }
      return line;
    })
    .join("\n")}\n`;
}

export function looksLikeHls(url, contentType) {
  return url.toLowerCase().split("?", 1)[0].endsWith(".m3u8") || String(contentType).toLowerCase().includes("mpegurl");
}

export function inferStreamKind(url, contentType = "") {
  const lowerUrl = String(url).toLowerCase().split("?", 1)[0];
  const lowerType = String(contentType).toLowerCase();
  if (looksLikeHls(url, contentType)) return "hls";
  if (lowerType.includes("mp2t") || lowerType.includes("mpegts") || lowerUrl.includes("/ts/") || lowerUrl.endsWith(".ts")) return "mpegts";
  if (lowerType.includes("mp4") || lowerUrl.endsWith(".mp4")) return "native";
  return "mpegts";
}

export async function proxyStream(req, res, targetUrl, slug, extraParams = {}) {
  return proxyStreamNative(req, res, targetUrl, slug, 0, extraParams);
}

export function proxyFmp4Stream(req, res, targetUrl) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-rw_timeout",
        "15000000",
        "-i",
        targetUrl,
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ac",
        "2",
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-frag_duration",
        "2000000",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });

    if (res.socket) {
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true, 30000);
    }
    res.status(200);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");

    res.on("close", () => {
      if (!ffmpeg.killed) ffmpeg.kill("SIGTERM");
    });

    pipeline(ffmpeg.stdout, res)
      .then(() => resolve())
      .catch((error) => {
        if (res.destroyed) resolve();
        else reject(error);
      });

    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code && code !== 255 && !res.destroyed) {
        reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

function sessionId(slug, targetUrl, compatibilityMode = false) {
  return crypto.createHash("sha256").update(`${slug}:${targetUrl}:${compatibilityMode ? "compat" : "copy"}`).digest("base64url").slice(0, 48);
}

export function createHlsSessionDirectory(id, temporaryRoot = os.tmpdir()) {
  const root = path.join(temporaryRoot, "iptv-share-hls");
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${id}-`));
}

function waitForHlsPlaylist(session, timeoutMs = 10000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fs.existsSync(session.playlistPath)) {
        resolve();
        return;
      }
      if (session.stopped) {
        reject(new Error("HLS session stopped before creating the playlist"));
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(session.stderr?.trim() || "Timed out waiting for HLS playlist"));
        return;
      }
      setTimeout(check, 250);
    };
    check();
  });
}

function playlistSegments(playlist) {
  return playlist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => path.basename(line));
}

export function playlistHasRecentSegment(playlist, dir, now = Date.now(), maxAgeMs = 20000) {
  const lastSegment = playlistSegments(playlist).at(-1);
  if (!lastSegment) return false;
  try {
    return now - fs.statSync(path.join(dir, lastSegment)).mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

function waitForPlaylistSegments(session, timeoutMs = 14000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fs.existsSync(session.playlistPath)) {
        const playlist = fs.readFileSync(session.playlistPath, "utf8");
        const readySegments = playlistSegments(playlist).filter((segment) => fs.existsSync(path.join(session.dir, segment)));
        if (readySegments.length >= 2 && playlistHasRecentSegment(playlist, session.dir)) {
          resolve(playlist);
          return;
        }
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("HLS playlist has not produced recent segments"));
        return;
      }
      setTimeout(check, 250);
    };
    check();
  });
}

function waitForSegment(file, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (fs.existsSync(file)) {
        resolve(true);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}

function probeCodecs(targetUrl) {
  return new Promise((resolve) => {
    const probe = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name",
        "-of",
        "json",
        "-rw_timeout",
        "10000000",
        targetUrl,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    const timer = setTimeout(() => {
      if (!probe.killed) probe.kill("SIGTERM");
      resolve({ video: "", audio: "" });
    }, 12000);
    probe.stdout.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-12000);
    });
    probe.on("error", () => {
      clearTimeout(timer);
      resolve({ video: "", audio: "" });
    });
    probe.on("close", () => {
      clearTimeout(timer);
      try {
        const streams = JSON.parse(output).streams || [];
        resolve({
          video: streams.find((stream) => stream.codec_type === "video")?.codec_name || "",
          audio: streams.find((stream) => stream.codec_type === "audio")?.codec_name || "",
        });
      } catch {
        resolve({ video: "", audio: "" });
      }
    });
  });
}

async function hlsCodecArgs(targetUrl, compatibilityMode = false) {
  // Compatibility mode always encodes both tracks, so probing would open an
  // unnecessary second connection to the live upstream.
  const codecs = compatibilityMode ? { video: "", audio: "" } : await probeCodecs(targetUrl);
  return hlsCodecPlan(codecs, compatibilityMode);
}

export function hlsCodecPlan(codecs, compatibilityMode = false) {
  const videoCopy = !compatibilityMode && ["h264", "hevc"].includes(codecs.video);
  const audioCopy = !compatibilityMode && ["aac", "mp3"].includes(codecs.audio);
  const videoTranscodeMode = config.ffmpegHwaccel === "vaapi" ? "vaapi" : "cpu";
  const videoTranscodeArgs =
    videoTranscodeMode === "vaapi"
      ? ["-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-qp", "23"]
      : ["-c:v", "libx264", "-preset", compatibilityMode ? "ultrafast" : "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p"];

  return {
    codecs,
    inputArgs: videoCopy || videoTranscodeMode !== "vaapi" ? [] : ["-vaapi_device", config.ffmpegVaapiDevice],
    outputArgs: [
      ...(videoCopy ? ["-c:v", "copy"] : videoTranscodeArgs),
      ...(compatibilityMode ? ["-force_key_frames", "expr:gte(t,n_forced*4)"] : []),
      "-c:a",
      audioCopy ? "copy" : "aac",
      ...(audioCopy ? [] : ["-b:a", "160k", "-ac", "2"]),
    ],
    videoMode: videoCopy ? "copy" : videoTranscodeMode,
    audioMode: audioCopy ? "copy" : "aac",
  };
}

function hlsSessionDetails(session) {
  const ageSeconds = Math.round((Date.now() - session.startedAt) / 1000);
  const idleSeconds = Math.round((Date.now() - session.lastAccessed) / 1000);
  return `share=${JSON.stringify(session.slug)} session=${session.id.slice(-12)} age=${ageSeconds}s idle=${idleSeconds}s playlists=${session.playlistRequests} segments=${session.segmentRequests}`;
}

function stopHlsSession(session, reason = "cleanup") {
  if (!session || session.stopped) return;
  session.stopped = true;
  console.info(`HLS session stopped (${reason}): ${hlsSessionDetails(session)}`);
  if (session?.process && !session.process.killed) session.process.kill("SIGTERM");
  if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
  if (session?.restartTimer) clearTimeout(session.restartTimer);
  if (hlsSessions.get(session.key) === session) hlsSessions.delete(session.key);
  if (hlsSessionsById.get(session.id) === session) hlsSessionsById.delete(session.id);
  if (session?.dir) {
    setTimeout(() => fs.rm(session.dir, { recursive: true, force: true }, () => {}), 500);
  }
}

export function stopAllHlsSessions() {
  for (const session of hlsSessions.values()) stopHlsSession(session, "shutdown");
}

export function activeHlsSessionForShare(id, slug) {
  const session = hlsSessionsById.get(String(id || ""));
  return Boolean(session && !session.stopped && session.slug === slug);
}

export function hlsCleanupCutoffAt(startedAt, cutoffWindow) {
  return cutoffWindow?.open_ended_cutoff
    ? Number.POSITIVE_INFINITY
    : Math.max(startedAt + 15000, ((cutoffWindow?.ends_at || 0) + config.shareAutoDeleteSeconds) * 1000);
}

function scheduleHlsCleanup(session, cutoffWindow) {
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  const cutoffAt = hlsCleanupCutoffAt(session.startedAt, cutoffWindow);
  const idleMs = 45000;
  session.cleanupTimer = setTimeout(() => {
    if (Date.now() - session.lastAccessed >= idleMs) stopHlsSession(session, "idle");
    else if (Date.now() >= cutoffAt) stopHlsSession(session, "cutoff");
    else scheduleHlsCleanup(session, cutoffWindow);
  }, Math.max(1, Math.min(idleMs, cutoffAt - Date.now())));
}

async function getOrCreateHlsSession(targetUrl, slug, cutoffWindow, compatibilityMode = false) {
  const key = sessionId(slug, targetUrl, compatibilityMode);
  const existing = hlsSessions.get(key);
  if (existing && !existing.stopped) {
    existing.lastAccessed = Date.now();
    scheduleHlsCleanup(existing, cutoffWindow);
    return existing;
  }

  if (hlsSessionStarts.has(key)) return hlsSessionStarts.get(key);
  const start = createHlsSession(targetUrl, slug, key, cutoffWindow, compatibilityMode);
  hlsSessionStarts.set(key, start);
  try {
    return await start;
  } finally {
    if (hlsSessionStarts.get(key) === start) hlsSessionStarts.delete(key);
  }
}

async function createHlsSession(targetUrl, slug, key, cutoffWindow, compatibilityMode) {
  const id = `${key}-${crypto.randomBytes(6).toString("hex")}`;
  const dir = createHlsSessionDirectory(id);
  const { inputArgs, outputArgs, codecs, videoMode, audioMode } = await hlsCodecArgs(targetUrl, compatibilityMode);
  const playlistPath = path.join(dir, "index.m3u8");
  const session = {
    key,
    id,
    slug,
    dir,
    playlistPath,
    targetUrl,
    inputArgs,
    outputArgs,
    process: null,
    startedAt: Date.now(),
    lastAccessed: Date.now(),
    codecs,
    videoMode,
    audioMode,
    compatibilityMode,
    playlistRequests: 0,
    segmentRequests: 0,
    restarts: 0,
    rapidFailures: 0,
    discontinuityBoundaries: new Set(),
    stderr: "",
    stopped: false,
  };
  hlsSessions.set(key, session);
  hlsSessionsById.set(id, session);
  launchHlsProcess(session);
  scheduleHlsCleanup(session, cutoffWindow);
  return session;
}

function launchHlsProcess(session) {
  const restarting = session.restarts > 0;
  const { targetUrl, inputArgs, outputArgs, dir, playlistPath } = session;
  if (restarting) {
    try {
      const previous = fs.readFileSync(playlistPath, "utf8");
      const segmentNumbers = [...previous.matchAll(/^segment_(\d{5})\.ts$/gm)].map((match) => Number(match[1]));
      if (segmentNumbers.length) session.discontinuityBoundaries.add(Math.max(...segmentNumbers) + 1);
    } catch (error) {
      if (error.code !== "ENOENT") console.warn(`Cannot read HLS playlist before restart: ${error.message}`);
    }
  }
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rw_timeout",
      "15000000",
      ...inputArgs,
      // Some live TS proxies send buffered media faster than real time. Without
      // pacing, the HLS live edge races ahead of viewers and forces seeks.
      "-re",
      "-i",
      targetUrl,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      ...outputArgs,
      "-f",
      "hls",
      "-hls_time",
      "4",
      "-hls_list_size",
      "12",
      "-hls_flags",
      `${restarting ? "append_list+discont_start+" : ""}omit_endlist${session.videoMode === "copy" ? "" : "+independent_segments"}`,
      "-hls_segment_filename",
      path.join(dir, "segment_%05d.ts"),
      playlistPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  session.process = ffmpeg;
  session.processStartedAt = Date.now();
  session.stderr = "";
  ffmpeg.stderr.on("data", (chunk) => {
    session.stderr = `${session.stderr}${chunk}`.slice(-2000);
  });
  console.info(`HLS FFmpeg started: ${hlsSessionDetails(session)} restart=${session.restarts} video=${session.videoMode} audio=${session.audioMode} compat=${session.compatibilityMode}`);
  ffmpeg.on("error", (error) => {
    session.stderr = error.message;
  });
  ffmpeg.on("close", (code, signal) => {
    console.info(`HLS FFmpeg exited: ${hlsSessionDetails(session)} code=${code} signal=${signal || "none"}`);
    if (code && session.stderr.trim()) console.warn(`HLS remux exited for ${session.slug}: ${session.stderr.trim().replaceAll(targetUrl, "[source]")}`);
    if (session.stopped || hlsSessions.get(session.key) !== session) return;
    const processAge = Date.now() - session.processStartedAt;
    session.rapidFailures = processAge >= 10000 ? 0 : session.rapidFailures + 1;
    const delayMs = Math.min(8000, 1000 * 2 ** Math.min(session.rapidFailures, 3));
    session.restartTimer = setTimeout(() => {
      session.restartTimer = null;
      if (session.stopped) return;
      session.restarts += 1;
      launchHlsProcess(session);
    }, delayMs);
  });
}

export function numberHlsDiscontinuities(playlist, boundaries) {
  const mediaSequence = Number(playlist.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1]);
  const discontinuitySequence = Number.isFinite(mediaSequence)
    ? [...boundaries].filter((boundary) => boundary < mediaSequence).length
    : 0;
  return playlist.replace(
    /^#EXT-X-MEDIA-SEQUENCE:(\d+)$/m,
    `#EXT-X-MEDIA-SEQUENCE:$1\n#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuitySequence}`,
  );
}

function rewriteLocalHlsPlaylist(playlist, req, session) {
  const numberedPlaylist = numberHlsDiscontinuities(playlist, session.discontinuityBoundaries);
  const baseParams = new URLSearchParams(req.query);
  baseParams.set("hls", "1");
  baseParams.set("session", session.id);
  baseParams.delete("segment");
  baseParams.delete("format");
  return `${numberedPlaylist
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const params = new URLSearchParams(baseParams);
      params.set("segment", path.basename(trimmed));
      return `${req.path}?${params.toString()}`;
    })
    .join("\n")}\n`;
}

function pruneHlsSegments(session, playlist) {
  if (Date.now() - (session.lastPrunedAt || 0) < 30000) return;
  session.lastPrunedAt = Date.now();
  const sequence = Number(playlist.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1]);
  if (!Number.isFinite(sequence) || sequence <= 48) return;
  const oldestToKeep = sequence - 48;
  fs.readdir(session.dir, (error, files) => {
    if (error || session.stopped) return;
    for (const file of files) {
      const number = Number(file.match(/^segment_(\d{5})\.ts$/)?.[1]);
      if (Number.isFinite(number) && number < oldestToKeep) {
        fs.rm(path.join(session.dir, file), () => {});
      }
    }
  });
}

export async function serveHlsRemuxPlaylist(req, res, targetUrl, slug, cutoffWindow) {
  const session = await getOrCreateHlsSession(targetUrl, slug, cutoffWindow, req.query.compat === "1");
  session.playlistRequests += 1;
  session.lastAccessed = Date.now();
  await waitForHlsPlaylist(session, session.compatibilityMode ? 35000 : 20000);
  const playlist = await waitForPlaylistSegments(session, session.compatibilityMode ? 30000 : 14000);
  pruneHlsSegments(session, playlist);
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-IPTV-Share-Video-Codec", session.codecs.video || "unknown");
  res.setHeader("X-IPTV-Share-Audio-Codec", session.codecs.audio || "unknown");
  res.setHeader("X-IPTV-Share-Video-Mode", session.videoMode || "unknown");
  res.setHeader("X-IPTV-Share-Audio-Mode", session.audioMode || "unknown");
  res.send(rewriteLocalHlsPlaylist(playlist, req, session));
}

export async function serveHlsRemuxSegment(req, res) {
  const session = hlsSessionsById.get(String(req.query.session || ""));
  const segment = path.basename(String(req.query.segment || ""));
  if (!session || !segment || segment.includes("..")) {
    console.warn(`HLS segment unavailable: session=${String(req.query.session || "").slice(-12)} segment=${segment || "missing"}`);
    res.status(404).end();
    return;
  }
  const file = path.join(session.dir, segment);
  if (!(await waitForSegment(file))) {
    console.warn(`HLS segment missing: ${hlsSessionDetails(session)} segment=${segment}`);
    res.status(404).end();
    return;
  }
  session.lastAccessed = Date.now();
  session.segmentRequests += 1;
  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Accept-Ranges", "bytes");
  fs.createReadStream(file).pipe(res);
}

function requestModule(url) {
  return url.protocol === "https:" ? https : http;
}

function proxyStreamNative(req, res, targetUrl, slug, redirectCount, extraParams = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const startedAt = Date.now();
    const headers = {
      "User-Agent": "iptv-share/0.2",
      Accept: "*/*",
      Connection: "close",
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstreamReq = requestModule(parsedUrl).request(parsedUrl, { headers }, (upstream) => {
      const location = upstream.headers.location;
      if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && location && redirectCount < 5) {
        upstream.resume();
        resolve(proxyStreamNative(req, res, new URL(location, targetUrl).toString(), slug, redirectCount + 1, extraParams));
        return;
      }

      if (upstream.statusCode < 200 || upstream.statusCode > 299) {
        console.warn(`Stream upstream rejected: share=${JSON.stringify(slug)} status=${upstream.statusCode} age=${Date.now() - startedAt}ms`);
        upstream.resume();
        res.status(upstream.statusCode || 502).send("Upstream stream failed");
        resolve();
        return;
      }

      const contentType = upstream.headers["content-type"] || "application/octet-stream";
      if (looksLikeHls(targetUrl, contentType)) {
        const chunks = [];
        upstream.on("data", (chunk) => chunks.push(chunk));
        upstream.on("end", () => {
          const playlist = Buffer.concat(chunks).toString("utf8");
          res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
          res.setHeader("Cache-Control", "no-store");
          res.send(rewriteHlsPlaylist(playlist, targetUrl, slug, { viewer: req.query.viewer, ...extraParams }));
          resolve();
        });
        upstream.on("error", reject);
        return;
      }

      if (res.socket) {
        res.socket.setNoDelay(true);
        res.socket.setKeepAlive(true, 30000);
      }
      res.status(upstream.statusCode || 200);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Accel-Buffering", "no");
      for (const header of ["accept-ranges", "content-range", "content-length"]) {
        const value = upstream.headers[header];
        if (value) res.setHeader(header, value);
      }

      let bytes = 0;
      let viewerDisconnected = false;
      upstream.on("data", (chunk) => { bytes += chunk.length; });
      upstream.on("end", () => {
        console.info(`Stream upstream ended: share=${JSON.stringify(slug)} age=${Date.now() - startedAt}ms bytes=${bytes} status=${upstream.statusCode}`);
      });
      upstream.on("error", (error) => {
        if (!viewerDisconnected) console.warn(`Stream upstream error: share=${JSON.stringify(slug)} age=${Date.now() - startedAt}ms bytes=${bytes} reason=${error.message}`);
      });

      res.on("close", () => { viewerDisconnected = !res.writableFinished; });
      pipeline(upstream, res).then(resolve).catch((error) => {
        if (res.destroyed) resolve();
        else reject(error);
      });
    });

    upstreamReq.setTimeout(15000, () => upstreamReq.destroy(new Error("Upstream stream inactive for 15 seconds")));
    upstreamReq.on("error", reject);
    res.on("close", () => {
      if (!upstreamReq.destroyed && !res.writableFinished) {
        console.info(`Stream viewer disconnected: share=${JSON.stringify(slug)} age=${Date.now() - startedAt}ms`);
      }
      upstreamReq.destroy();
    });
    upstreamReq.end();
  });
}
