import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { playlistHasRecentSegment, proxyStream } from "../src/server/stream.js";

test("proxy keeps upstream alive when the incoming request completes, then closes it when viewer leaves", { timeout: 10000 }, async () => {
  let upstreamClosed = false;
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp2t" });
    const timer = setInterval(() => res.write(Buffer.alloc(188, 0x47)), 20);
    res.on("close", () => {
      clearInterval(timer);
      upstreamClosed = true;
    });
  });
  const app = express();
  app.get("/stream", (req, res) => {
    // IncomingMessage.close signals completion on current Node versions.
    req.emit("close");
    proxyStream(req, res, `http://127.0.0.1:${upstream.address().port}/ts`, "test").catch(() => res.destroy());
  });
  const proxy = http.createServer(app);
  await Promise.all([
    new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve)),
  ]);
  try {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.ok((await reader.read()).value.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(upstreamClosed, false);
    controller.abort();
    const deadline = Date.now() + 2000;
    while (!upstreamClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(upstreamClosed, true);
  } finally {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
  }
});

test("HLS playlist requires a recent last segment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iptv-share-playlist-test-"));
  try {
    const file = path.join(dir, "segment_00003.ts");
    fs.writeFileSync(file, "segment");
    const playlist = "#EXTM3U\nsegment_00003.ts\n";
    assert.equal(playlistHasRecentSegment(playlist, dir), true);
    const old = new Date(Date.now() - 30000);
    fs.utimesSync(file, old, old);
    assert.equal(playlistHasRecentSegment(playlist, dir), false);
    assert.equal(playlistHasRecentSegment("#EXTM3U\nsegment_missing.ts\n", dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
