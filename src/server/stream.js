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

    req.on("close", () => {
      if (!ffmpeg.killed) ffmpeg.kill("SIGTERM");
    });

    pipeline(ffmpeg.stdout, res)
      .then(() => resolve())
      .catch((error) => {
        if (req.destroyed || res.destroyed) resolve();
        else reject(error);
      });

    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code && code !== 255 && !req.destroyed && !res.destroyed) {
        reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

function sessionId(slug, targetUrl) {
  return crypto.createHash("sha256").update(`${slug}:${targetUrl}`).digest("base64url").slice(0, 48);
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
      if (session.process.exitCode !== null || session.process.signalCode) {
        reject(new Error(session.stderr?.trim() || "FFmpeg exited before creating the HLS playlist"));
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

function waitForPlaylistSegments(session, timeoutMs = 14000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fs.existsSync(session.playlistPath)) {
        const playlist = fs.readFileSync(session.playlistPath, "utf8");
        const readySegments = playlistSegments(playlist).filter((segment) => fs.existsSync(path.join(session.dir, segment)));
        if (readySegments.length >= 2) {
          resolve(playlist);
          return;
        }
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(session.stderr?.trim() || "Timed out waiting for HLS segments"));
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

async function hlsCodecArgs(targetUrl) {
  const codecs = await probeCodecs(targetUrl);
  const videoCopy = ["h264", "hevc"].includes(codecs.video);
  const audioCopy = ["aac", "mp3"].includes(codecs.audio);
  const videoTranscodeMode = config.ffmpegHwaccel === "vaapi" ? "vaapi" : "cpu";
  const videoTranscodeArgs =
    videoTranscodeMode === "vaapi"
      ? ["-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-qp", "23"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p"];

  return {
    codecs,
    inputArgs: videoCopy || videoTranscodeMode !== "vaapi" ? [] : ["-vaapi_device", config.ffmpegVaapiDevice],
    outputArgs: [
      ...(videoCopy ? ["-c:v", "copy"] : videoTranscodeArgs),
      "-c:a",
      audioCopy ? "copy" : "aac",
      ...(audioCopy ? [] : ["-b:a", "160k", "-ac", "2"]),
    ],
    videoMode: videoCopy ? "copy" : videoTranscodeMode,
    audioMode: audioCopy ? "copy" : "aac",
  };
}

function stopHlsSession(session) {
  if (session?.process && !session.process.killed) session.process.kill("SIGTERM");
  if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
  hlsSessions.delete(session.id);
  if (session?.dir) {
    setTimeout(() => fs.rm(session.dir, { recursive: true, force: true }, () => {}), 500);
  }
}

function scheduleHlsCleanup(session, cutoffWindow) {
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  const cutoffMs = cutoffWindow?.open_ended_cutoff
    ? Number.POSITIVE_INFINITY
    : Math.max(15000, ((cutoffWindow?.ends_at || 0) + config.shareAutoDeleteSeconds - Math.floor(Date.now() / 1000)) * 1000);
  const idleMs = 45000;
  session.cleanupTimer = setTimeout(() => {
    if (Date.now() - session.lastAccessed > idleMs || Date.now() >= session.startedAt + cutoffMs) stopHlsSession(session);
    else scheduleHlsCleanup(session, cutoffWindow);
  }, Math.min(idleMs, cutoffMs));
}

async function getOrCreateHlsSession(targetUrl, slug, cutoffWindow) {
  const id = sessionId(slug, targetUrl);
  const existing = hlsSessions.get(id);
  if (existing && existing.process.exitCode === null) {
    existing.lastAccessed = Date.now();
    scheduleHlsCleanup(existing, cutoffWindow);
    return existing;
  }

  const dir = createHlsSessionDirectory(id);
  const { inputArgs, outputArgs, codecs, videoMode, audioMode } = await hlsCodecArgs(targetUrl);
  const playlistPath = path.join(dir, "index.m3u8");
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rw_timeout",
      "15000000",
      ...inputArgs,
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
      "6",
      "-hls_flags",
      "delete_segments+append_list+omit_endlist+independent_segments",
      "-hls_segment_filename",
      path.join(dir, "segment_%05d.ts"),
      playlistPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  ffmpeg.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });
  const session = {
    id,
    dir,
    playlistPath,
    process: ffmpeg,
    startedAt: Date.now(),
    lastAccessed: Date.now(),
    codecs,
    videoMode,
    audioMode,
    get stderr() {
      return stderr;
    },
  };
  hlsSessions.set(id, session);
  ffmpeg.on("close", () => {
    setTimeout(() => {
      if (hlsSessions.get(id) === session) stopHlsSession(session);
    }, 30000);
  });
  scheduleHlsCleanup(session, cutoffWindow);
  return session;
}

function rewriteLocalHlsPlaylist(playlist, req, session) {
  const baseParams = new URLSearchParams(req.query);
  baseParams.set("hls", "1");
  baseParams.set("session", session.id);
  baseParams.delete("segment");
  baseParams.delete("format");
  return `${playlist
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

export async function serveHlsRemuxPlaylist(req, res, targetUrl, slug, cutoffWindow) {
  const session = await getOrCreateHlsSession(targetUrl, slug, cutoffWindow);
  await waitForHlsPlaylist(session);
  session.lastAccessed = Date.now();
  const playlist = await waitForPlaylistSegments(session);
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
  const session = hlsSessions.get(String(req.query.session || ""));
  const segment = path.basename(String(req.query.segment || ""));
  if (!session || !segment || segment.includes("..")) {
    res.status(404).end();
    return;
  }
  const file = path.join(session.dir, segment);
  if (!(await waitForSegment(file))) {
    res.status(404).end();
    return;
  }
  session.lastAccessed = Date.now();
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
    let activeRequest = null;
    let reconnectTimer = null;
    let downstreamStarted = false;
    let finished = false;
    let retryDelayMs = 250;
    const initialRetryDeadline = Date.now() + 10000;

    const finish = (error = null) => {
      if (finished) return;
      finished = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (activeRequest && !activeRequest.destroyed) activeRequest.destroy();
      req.off("aborted", stop);
      res.off("close", stop);
      if (error) reject(error);
      else resolve();
    };
    const stop = () => finish();
    req.once("aborted", stop);
    res.once("close", stop);

    const reconnect = (url) => {
      if (finished || req.destroyed || res.destroyed) {
        finish();
        return;
      }
      const delay = retryDelayMs;
      retryDelayMs = Math.min(5000, retryDelayMs * 2);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect(url, 0);
      }, delay);
      reconnectTimer.unref?.();
    };

    const connect = (url, redirects) => {
      if (finished) return;
      let attemptFinished = false;
      const retryAttempt = (error = null) => {
        if (attemptFinished || finished) return;
        attemptFinished = true;
        if (downstreamStarted || Date.now() < initialRetryDeadline) reconnect(targetUrl);
        else finish(error || new Error("Upstream stream ended before playback started"));
      };
      const parsedUrl = new URL(url);
      const headers = {
        "User-Agent": "iptv-share/0.2",
        Accept: "*/*",
        Connection: "close",
      };
      if (!downstreamStarted && req.headers.range) headers.Range = req.headers.range;

      const request = requestModule(parsedUrl).request(parsedUrl, { headers }, (upstream) => {
        const location = upstream.headers.location;
        if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && location && redirects < 5) {
          attemptFinished = true;
          upstream.resume();
          connect(new URL(location, url).toString(), redirects + 1);
          return;
        }

        if (upstream.statusCode < 200 || upstream.statusCode > 299) {
          upstream.resume();
          const retryableStatus = [408, 425, 429].includes(upstream.statusCode) || upstream.statusCode >= 500;
          if (downstreamStarted || retryableStatus) retryAttempt(new Error(`Upstream stream returned HTTP ${upstream.statusCode}`));
          else {
            attemptFinished = true;
            res.status(upstream.statusCode || 502).send("Upstream stream failed");
            finish();
          }
          return;
        }

        const contentType = upstream.headers["content-type"] || "application/octet-stream";
        if (looksLikeHls(url, contentType)) {
          const chunks = [];
          upstream.on("data", (chunk) => chunks.push(chunk));
          upstream.on("end", () => {
            attemptFinished = true;
            const playlist = Buffer.concat(chunks).toString("utf8");
            res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
            res.setHeader("Cache-Control", "no-store");
            res.send(rewriteHlsPlaylist(playlist, url, slug, { viewer: req.query.viewer, ...extraParams }));
            finish();
          });
          upstream.on("error", (error) => {
            attemptFinished = true;
            finish(error);
          });
          return;
        }

        const continuousMpegTs = inferStreamKind(url, contentType) === "mpegts";
        if (!downstreamStarted) {
          downstreamStarted = true;
          if (res.socket) {
            res.socket.setNoDelay(true);
            res.socket.setKeepAlive(true, 30000);
          }
          res.status(upstream.statusCode || 200);
          res.setHeader("Content-Type", contentType);
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-Accel-Buffering", "no");
          if (!continuousMpegTs) {
            for (const header of ["accept-ranges", "content-range", "content-length"]) {
              const value = upstream.headers[header];
              if (value) res.setHeader(header, value);
            }
          }
        }

        if (!continuousMpegTs) {
          pipeline(upstream, res).then(() => {
            attemptFinished = true;
            finish();
          }).catch((error) => {
            attemptFinished = true;
            if (req.destroyed || res.destroyed) finish();
            else finish(error);
          });
          return;
        }

        // MPEG-TS live sources may end individual upstream HTTP responses at
        // the live edge. Keep the signed public response open and splice the
        // next upstream response into it. MPEG-TS is explicitly designed to
        // tolerate transport discontinuities, while bounded backoff prevents
        // an unavailable source from becoming a retry loop.
        upstream.once("data", () => { retryDelayMs = 250; });
        let settled = false;
        const continueStream = () => {
          if (settled) return;
          settled = true;
          upstream.unpipe(res);
          retryAttempt();
        };
        upstream.once("end", continueStream);
        upstream.once("aborted", continueStream);
        upstream.once("error", continueStream);
        upstream.pipe(res, { end: false });
      });

      activeRequest = request;
      request.setTimeout(15000, () => request.destroy(new Error("Upstream stream timed out")));
      request.once("error", retryAttempt);
      request.end();
    };

    connect(targetUrl, redirectCount);
  });
}
