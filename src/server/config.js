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
  transcodeMpegTs: process.env.TRANSCODE_MPEGTS !== "false",
  nodeEnv: process.env.NODE_ENV || "production",
};
