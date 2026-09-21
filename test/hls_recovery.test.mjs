import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { numberHlsDiscontinuities, serveHlsRemuxPlaylist, serveHlsRemuxSegment, stopAllHlsSessions } from "../src/server/stream.js";

test("sliding HLS playlists retain discontinuity numbering after markers age out", () => {
  const boundaries = new Set([34, 74]);
  const atBoundary = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:34\n#EXT-X-DISCONTINUITY\nsegment_00034.ts\n";
  assert.match(numberHlsDiscontinuities(atBoundary, boundaries), /#EXT-X-DISCONTINUITY-SEQUENCE:0\n#EXT-X-DISCONTINUITY/);

  const afterFirst = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:35\nsegment_00035.ts\n";
  assert.match(numberHlsDiscontinuities(afterFirst, boundaries), /#EXT-X-DISCONTINUITY-SEQUENCE:1\nsegment_00035.ts/);

  const afterSecond = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:75\nsegment_00075.ts\n";
  assert.match(numberHlsDiscontinuities(afterSecond, boundaries), /#EXT-X-DISCONTINUITY-SEQUENCE:2\nsegment_00075.ts/);
});

function syntheticTs() {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=160x90:rate=15:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "30",
    "-c:a", "aac", "-f", "mpegts", "pipe:1",
  ], { maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

async function playlistFor(sourceUrl) {
  let body;
  await serveHlsRemuxPlaylist(
    { query: { compat: "1" }, path: "/api/public/stream/test" },
    { setHeader() {}, send(value) { body = value; } },
    sourceUrl,
    "test",
    { open_ended_cutoff: true },
  );
  return body;
}

async function segmentBytes(segmentUrl) {
  const url = new URL(segmentUrl, "http://localhost");
  const response = new PassThrough();
  response.setHeader = () => {};
  response.status = (code) => { response.statusCode = code; return response; };
  let bytes = 0;
  response.on("data", (chunk) => { bytes += chunk.length; });
  const ended = once(response, "end");
  await serveHlsRemuxSegment({ query: Object.fromEntries(url.searchParams) }, response);
  await ended;
  assert.notEqual(response.statusCode, 404);
  return bytes;
}

test("HLS continues numbering and marks a discontinuity after upstream EOF and a brief 503", { timeout: 45000 }, async () => {
  const fixture = syntheticTs();
  let connections = 0;
  const server = http.createServer((req, res) => {
    connections += 1;
    if (connections === 2) {
      res.writeHead(503).end("temporarily unavailable");
      return;
    }
    res.writeHead(200, { "Content-Type": "video/mp2t" });
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= fixture.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      const next = Math.min(fixture.length, offset + 4096);
      res.write(fixture.subarray(offset, next));
      offset = next;
    }, 20);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const sourceUrl = `http://127.0.0.1:${server.address().port}/stream`;
    const first = await playlistFor(sourceUrl);
    const firstSession = first.match(/[?&]session=([^&\s]+)/)?.[1];
    assert.ok(firstSession);
    assert.match(first, /segment_00000\.ts/);
    const firstSegment = first.split(/\r?\n/).find((line) => line.includes("segment_00000.ts"));
    assert.ok(firstSegment);

    let recovered = "";
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      recovered = await playlistFor(sourceUrl);
      if (connections >= 3 && recovered.includes("#EXT-X-DISCONTINUITY") && recovered.includes("segment_00003.ts")) break;
    }
    assert.ok(connections >= 3, `expected recovery after 503; got ${connections} upstream connections`);
    assert.equal(recovered.match(/[?&]session=([^&\s]+)/)?.[1], firstSession);
    assert.match(recovered, /#EXT-X-DISCONTINUITY/);
    assert.match(recovered, /segment_00003\.ts/);
    assert.ok(await segmentBytes(firstSegment), "a segment from the previous playlist must remain readable");
  } finally {
    stopAllHlsSessions();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("initial HLS request waits through a brief upstream 503 outage", { timeout: 25000 }, async () => {
  const fixture = syntheticTs();
  let connections = 0;
  const server = http.createServer((req, res) => {
    connections += 1;
    if (connections <= 2) {
      res.writeHead(503).end("temporarily unavailable");
      return;
    }
    res.writeHead(200, { "Content-Type": "video/mp2t" });
    res.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const startedAt = Date.now();
    const playlist = await playlistFor(`http://127.0.0.1:${server.address().port}/stream`);
    assert.ok(connections >= 3);
    assert.match(playlist, /segment_00000\.ts/);
    assert.ok(Date.now() - startedAt >= 5000, "buffered upstream media must not generate a racing live playlist");
  } finally {
    stopAllHlsSessions();
    await new Promise((resolve) => server.close(resolve));
  }
});
