import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { proxyStream } from "../src/server/stream.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

test("MPEG-TS proxy keeps one signed response open across upstream EOF and a temporary 503", async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    if (upstreamRequests === 2) {
      res.statusCode = 503;
      res.end("temporarily unavailable");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "video/mp2t");
    if (upstreamRequests === 1) {
      res.end("FIRST-");
      return;
    }
    res.write("SECOND");
    const timer = setInterval(() => res.write("."), 25);
    req.once("close", () => clearInterval(timer));
  });
  const upstreamPort = await listen(upstream);

  const proxy = http.createServer((req, res) => {
    req.query = {};
    res.status = (code) => { res.statusCode = code; return res; };
    res.send = (body) => res.end(body);
    void proxyStream(req, res, `http://127.0.0.1:${upstreamPort}/live.ts`, "test").catch((error) => {
      if (!res.headersSent) res.writeHead(502);
      if (!res.destroyed) res.end(error.message);
    });
  });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for reconnected MPEG-TS bytes")), 5000);
    const request = http.get(`http://127.0.0.1:${proxyPort}/stream`, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (!body.includes("FIRST-SECOND")) return;
        clearTimeout(timeout);
        resolve({ status: response.statusCode, body });
        request.destroy();
      });
      response.once("error", (error) => {
        if (error.code !== "ECONNRESET") reject(error);
      });
    });
    request.once("error", (error) => {
      if (error.code !== "ECONNRESET") reject(error);
    });
  });

  assert.equal(result.status, 200);
  assert.match(result.body, /FIRST-SECOND/);
  assert.equal(upstreamRequests, 3, "one downstream response should survive EOF, one 503, and the recovered source");
});

test("MPEG-TS proxy retries a temporary upstream failure before sending response headers", async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    if (upstreamRequests === 1) {
      res.statusCode = 503;
      res.end("temporarily unavailable");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "video/mp2t");
    res.write("RECOVERED");
    const timer = setInterval(() => res.write("."), 25);
    req.once("close", () => clearInterval(timer));
  });
  const upstreamPort = await listen(upstream);

  const proxy = http.createServer((req, res) => {
    req.query = {};
    res.status = (code) => { res.statusCode = code; return res; };
    res.send = (body) => res.end(body);
    void proxyStream(req, res, `http://127.0.0.1:${upstreamPort}/live.ts`, "test").catch((error) => {
      if (!res.headersSent) res.writeHead(502);
      if (!res.destroyed) res.end(error.message);
    });
  });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for initial upstream recovery")), 5000);
    const request = http.get(`http://127.0.0.1:${proxyPort}/stream`, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (!body.includes("RECOVERED")) return;
        clearTimeout(timeout);
        resolve({ status: response.statusCode, body });
        request.destroy();
      });
      response.once("error", (error) => {
        if (error.code !== "ECONNRESET") reject(error);
      });
    });
    request.once("error", (error) => {
      if (error.code !== "ECONNRESET") reject(error);
    });
  });

  assert.equal(result.status, 200);
  assert.match(result.body, /RECOVERED/);
  assert.equal(upstreamRequests, 2);
});
