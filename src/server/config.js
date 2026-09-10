import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function numberEnv(name, fallback) {
  return Number(process.env[name] || fallback);
}

export const config = {
  rootDir,
  port: Number(process.env.PORT || 8080),
  databasePath: process.env.DATABASE_PATH || path.join(rootDir, "data", "app.sqlite"),
  appUsername: process.env.APP_USERNAME || "admin",
  appPassword: process.env.APP_PASSWORD || "admin",
  sessionSecret: process.env.SESSION_SECRET || "dev-secret-change-me",
  m3uUrl: process.env.M3U_URL || path.join(rootDir, "sample", "sample.m3u"),
  epgUrl: process.env.EPG_URL || path.join(rootDir, "sample", "sample.xml"),
  nflMapperTimezone: process.env.NFL_MAPPER_TIMEZONE || "America/New_York",
  nflMapperDurationSeconds: numberEnv("NFL_MAPPER_DURATION_SECONDS", 6 * 60 * 60),
  nflMapperSourceUrl: process.env.NFL_MAPPER_SOURCE_URL || "https://github.com/ferteque/Curated-M3U-Repository/raw/refs/heads/main/epg6.xml.gz",
  nflMapperSourceCacheSeconds: numberEnv("NFL_MAPPER_SOURCE_CACHE_SECONDS", 24 * 60 * 60),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  epgRefreshSeconds: Number(process.env.EPG_REFRESH_SECONDS || 21600),
  streamGraceSeconds: Number(process.env.STREAM_GRACE_SECONDS || 600),
  shareAutoDeleteSeconds: Number(process.env.SHARE_AUTO_DELETE_SECONDS || 300),
  transcodeMpegTs: process.env.TRANSCODE_MPEGTS !== "false",
  ffmpegHwaccel: String(process.env.FFMPEG_HWACCEL || "none").toLowerCase(),
  ffmpegVaapiDevice: process.env.FFMPEG_VAAPI_DEVICE || "/dev/dri/renderD128",
  espnSearchCacheSeconds: Number(process.env.ESPN_SEARCH_CACHE_SECONDS || 21600),
  espnLiveCacheSeconds: numberEnv("ESPN_LIVE_CACHE_SECONDS", 60),
  espnLiveCacheSecondsByLeague: {
    nfl: numberEnv("ESPN_LIVE_CACHE_SECONDS_NFL", process.env.ESPN_LIVE_CACHE_SECONDS || 60),
    mlb: numberEnv("ESPN_LIVE_CACHE_SECONDS_MLB", process.env.ESPN_LIVE_CACHE_SECONDS || 180),
    nba: numberEnv("ESPN_LIVE_CACHE_SECONDS_NBA", process.env.ESPN_LIVE_CACHE_SECONDS || 60),
    ncaafb: numberEnv("ESPN_LIVE_CACHE_SECONDS_NCAAFB", process.env.ESPN_LIVE_CACHE_SECONDS || 60),
    ncaamb: numberEnv("ESPN_LIVE_CACHE_SECONDS_NCAAMB", process.env.ESPN_LIVE_CACHE_SECONDS || 60),
  },
  espnSummaryCacheSecondsByLeague: {
    nfl: numberEnv("ESPN_SUMMARY_CACHE_SECONDS_NFL", 180),
    mlb: numberEnv("ESPN_SUMMARY_CACHE_SECONDS_MLB", 180),
    nba: numberEnv("ESPN_SUMMARY_CACHE_SECONDS_NBA", 180),
    ncaafb: numberEnv("ESPN_SUMMARY_CACHE_SECONDS_NCAAFB", 180),
    ncaamb: numberEnv("ESPN_SUMMARY_CACHE_SECONDS_NCAAMB", 180),
  },
  espnFastcastCacheSecondsByLeague: {
    nfl: numberEnv("ESPN_FASTCAST_CACHE_SECONDS_NFL", 10),
    mlb: numberEnv("ESPN_FASTCAST_CACHE_SECONDS_MLB", 5),
    nba: numberEnv("ESPN_FASTCAST_CACHE_SECONDS_NBA", 10),
    ncaafb: numberEnv("ESPN_FASTCAST_CACHE_SECONDS_NCAAFB", 10),
    ncaamb: numberEnv("ESPN_FASTCAST_CACHE_SECONDS_NCAAMB", 10),
  },
  discordWebhookLeadSeconds: numberEnv("DISCORD_WEBHOOK_LEAD_SECONDS", 900),
  discordWebhookTickSeconds: numberEnv("DISCORD_WEBHOOK_TICK_SECONDS", 60),
  discordWebhookRefreshSecondsByLeague: {
    nfl: numberEnv("DISCORD_WEBHOOK_REFRESH_SECONDS_NFL", 180),
    mlb: numberEnv("DISCORD_WEBHOOK_REFRESH_SECONDS_MLB", 180),
    nba: numberEnv("DISCORD_WEBHOOK_REFRESH_SECONDS_NBA", 180),
    ncaafb: numberEnv("DISCORD_WEBHOOK_REFRESH_SECONDS_NCAAFB", 180),
    ncaamb: numberEnv("DISCORD_WEBHOOK_REFRESH_SECONDS_NCAAMB", 180),
  },
  espnMaxRequestsPerDay: Number(process.env.ESPN_MAX_REQUESTS_PER_DAY || 2000),
  nodeEnv: process.env.NODE_ENV || "production",
};
