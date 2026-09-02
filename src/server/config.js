import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const config = {
  rootDir,
  port: Number(process.env.PORT || 8080),
  databasePath: process.env.DATABASE_PATH || path.join(rootDir, "data", "app.sqlite"),
  appUsername: process.env.APP_USERNAME || "admin",
  appPassword: process.env.APP_PASSWORD || "admin",
  sessionSecret: process.env.SESSION_SECRET || "dev-secret-change-me",
  m3uUrl: process.env.M3U_URL || path.join(rootDir, "sample", "sample.m3u"),
  epgUrl: process.env.EPG_URL || path.join(rootDir, "sample", "sample.xml"),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  epgRefreshSeconds: Number(process.env.EPG_REFRESH_SECONDS || 21600),
  streamGraceSeconds: Number(process.env.STREAM_GRACE_SECONDS || 0),
  shareAutoDeleteSeconds: Number(process.env.SHARE_AUTO_DELETE_SECONDS || 300),
  transcodeMpegTs: process.env.TRANSCODE_MPEGTS !== "false",
  ffmpegHwaccel: String(process.env.FFMPEG_HWACCEL || "none").toLowerCase(),
  ffmpegVaapiDevice: process.env.FFMPEG_VAAPI_DEVICE || "/dev/dri/renderD128",
  espnSearchCacheSeconds: Number(process.env.ESPN_SEARCH_CACHE_SECONDS || 21600),
  espnLiveCacheSeconds: Number(process.env.ESPN_LIVE_CACHE_SECONDS || 60),
  espnMaxRequestsPerDay: Number(process.env.ESPN_MAX_REQUESTS_PER_DAY || 2000),
  nodeEnv: process.env.NODE_ENV || "production",
};
