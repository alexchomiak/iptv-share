import crypto from "node:crypto";
import { config } from "./config.js";

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const digest = crypto.pbkdf2Sync(password, salt, 160000, 32, "sha256").toString("base64");
  return `${salt}$${digest}`;
}

export function verifyPassword(password, encoded) {
  if (!encoded || !encoded.includes("$")) return false;
  const [salt] = encoded.split("$");
  return crypto.timingSafeEqual(Buffer.from(hashPassword(password, salt)), Buffer.from(encoded));
}

export function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function signedShareCookie(shareId) {
  return crypto.createHmac("sha256", config.sessionSecret).update(`share:${shareId}`).digest("hex");
}

export function signStreamTarget(slug, targetUrl) {
  return crypto.createHmac("sha256", config.sessionSecret).update(`stream:${slug}:${targetUrl}`).digest("hex");
}

export function safeCompare(left, right) {
  const a = Buffer.from(left || "");
  const b = Buffer.from(right || "");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
