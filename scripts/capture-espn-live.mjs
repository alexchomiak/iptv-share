#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";

const DEFAULT_URL = "https://www.espn.com/mlb/playbyplay/_/gameId/401816791";
const url = process.argv.find((arg) => arg.startsWith("http")) || DEFAULT_URL;
const durationMs = Number(readFlag("--duration", "90")) * 1000;
const outDir = path.resolve(readFlag("--out", "artifacts"));
const executablePath = readFlag("--chrome", process.env.PUPPETEER_EXECUTABLE_PATH || findChrome());
const headless = hasFlag("--headless");

if (!executablePath) {
  console.error("Could not find Chrome/Chromium. Pass --chrome /path/to/chrome.");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const capture = {
  startedAt: new Date().toISOString(),
  url,
  durationMs,
  executablePath,
  requests: [],
  responses: [],
  jsonBodies: [],
  wsFrames: [],
  console: [],
  errors: [],
};

const browser = await puppeteer.launch({
  executablePath,
  headless: headless ? "new" : false,
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "sharetv-espn-capture-")),
  args: [
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-sandbox",
  ],
});

try {
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
  });

  const cdp = await page.createCDPSession();
  const trackedRequests = new Map();

  cdp.on("Network.requestWillBeSent", (event) => {
    if (!isInterestingUrl(event.request?.url)) return;
    trackedRequests.set(event.requestId, event.request.url);
    capture.requests.push({
      at: new Date().toISOString(),
      id: event.requestId,
      type: event.type,
      method: event.request.method,
      url: event.request.url,
      headers: redactHeaders(event.request.headers),
      initiator: event.initiator?.type,
    });
  });

  cdp.on("Network.responseReceived", (event) => {
    const responseUrl = event.response?.url || trackedRequests.get(event.requestId);
    if (!isInterestingUrl(responseUrl)) return;
    trackedRequests.set(event.requestId, responseUrl);
    capture.responses.push({
      at: new Date().toISOString(),
      id: event.requestId,
      type: event.type,
      status: event.response.status,
      mimeType: event.response.mimeType,
      url: responseUrl,
      headers: redactHeaders(event.response.headers),
    });
  });

  cdp.on("Network.loadingFinished", async (event) => {
    const responseUrl = trackedRequests.get(event.requestId);
    if (!isInterestingUrl(responseUrl)) return;
    try {
      const body = await cdp.send("Network.getResponseBody", { requestId: event.requestId });
      if (!looksLikeUsefulBody(responseUrl, body.body)) return;
      capture.jsonBodies.push({
        at: new Date().toISOString(),
        id: event.requestId,
        url: responseUrl,
        base64Encoded: body.base64Encoded,
        body: truncateBody(body.body),
        parsed: parseMaybeJson(body.body),
      });
    } catch (error) {
      capture.errors.push({ at: new Date().toISOString(), url: responseUrl, error: error.message });
    }
  });

  cdp.on("Network.webSocketCreated", (event) => {
    if (!isInterestingUrl(event.url)) return;
    capture.wsFrames.push({ at: new Date().toISOString(), id: event.requestId, direction: "created", url: event.url });
  });
  cdp.on("Network.webSocketWillSendHandshakeRequest", (event) => {
    capture.wsFrames.push({
      at: new Date().toISOString(),
      id: event.requestId,
      direction: "handshake-sent",
      headers: redactHeaders(event.request?.headers || {}),
    });
  });
  cdp.on("Network.webSocketHandshakeResponseReceived", (event) => {
    capture.wsFrames.push({
      at: new Date().toISOString(),
      id: event.requestId,
      direction: "handshake-received",
      status: event.response?.status,
      headers: redactHeaders(event.response?.headers || {}),
    });
  });
  cdp.on("Network.webSocketFrameSent", (event) => recordWsFrame("sent", event));
  cdp.on("Network.webSocketFrameReceived", (event) => recordWsFrame("received", event));
  cdp.on("Network.webSocketClosed", (event) => {
    capture.wsFrames.push({ at: new Date().toISOString(), id: event.requestId, direction: "closed" });
  });

  page.on("console", (message) => {
    capture.console.push({
      at: new Date().toISOString(),
      type: message.type(),
      text: message.text(),
    });
  });
  page.on("pageerror", (error) => {
    capture.errors.push({ at: new Date().toISOString(), error: error.stack || error.message });
  });

  await cdp.send("Network.enable", {
    maxResourceBufferSize: 10_000_000,
    maxTotalBufferSize: 80_000_000,
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  await writeCapture("duration");
} catch (error) {
  capture.errors.push({ at: new Date().toISOString(), error: error.stack || error.message });
  await writeCapture("error");
  process.exitCode = 1;
} finally {
  await browser.close();
}

function recordWsFrame(direction, event) {
  const payload = event.response?.payloadData || "";
  capture.wsFrames.push({
    at: new Date().toISOString(),
    id: event.requestId,
    direction,
    opcode: event.response?.opcode,
    mask: event.response?.mask,
    payload: truncateBody(payload, 50_000),
    parsed: parseMaybeJson(payload),
  });
}

async function writeCapture(reason) {
  capture.finishedAt = new Date().toISOString();
  capture.reason = reason;
  const file = path.join(outDir, `espn-live-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(capture, null, 2));
  console.log(file);
}

function readFlag(name, fallback) {
  const arg = process.argv.find((item) => item === name || item.startsWith(`${name}=`));
  if (!arg) return fallback;
  if (arg.includes("=")) return arg.split("=").slice(1).join("=");
  const index = process.argv.indexOf(arg);
  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name) || process.argv.some((arg) => arg.startsWith(`${name}=`) && arg.split("=").slice(1).join("=") !== "false");
}

function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function isInterestingUrl(value = "") {
  return /espn|bamgrid|fastcast|semfs|sports\.core|cdn\.espn/i.test(value);
}

function looksLikeUsefulBody(responseUrl, body = "") {
  if (!body || body.length < 2) return false;
  if (/\.js(\?|$)|\.css(\?|$)|\.png(\?|$)|\.jpg(\?|$)|\.svg(\?|$)|\.woff/i.test(responseUrl)) return false;
  return /^[\s[{]/.test(body) || /checkpoint|gamepackage|playByPlay|competitors|sports/i.test(body);
}

function truncateBody(body = "", max = 250_000) {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}\n...[truncated ${body.length - max} chars]`;
}

function parseMaybeJson(payload) {
  if (!payload || !/^[\s[{]/.test(payload)) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function redactHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      /authorization|cookie|token|key|session|secret/i.test(key) ? "[redacted]" : value,
    ]),
  );
}
