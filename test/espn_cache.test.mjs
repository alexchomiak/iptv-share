import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmpDir = mkdtempSync(path.join(tmpdir(), "iptv-espn-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.sqlite");
process.env.ESPN_MAX_REQUESTS_PER_DAY = "2000";
process.on("exit", () => rmSync(tmpDir, { recursive: true, force: true }));

const { db, initDb } = await import("../src/server/db.js");
initDb();
const { fetchJsonCached } = await import("../src/server/espn.js");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const now = () => Math.floor(Date.now() / 1000);
const base = "https://espn.test/game";

function seedCache(url, payload, expiresIn) {
  db.prepare(
    "INSERT OR REPLACE INTO espn_cache(cache_key,url,payload,fetched_at,expires_at) VALUES (?,?,?,?,?)",
  ).run(sha(url), url, JSON.stringify(payload), now() - 1000, now() + expiresIn);
}
function clearCaches() {
  db.prepare("DELETE FROM espn_cache").run();
  db.prepare("DELETE FROM espn_request_log").run();
}
test("non-OK response returns stale cache (not an error)", async () => {
  const url = base + "/bad";
  clearCaches();
  seedCache(url, { state: "IN", n: 1 }, -100);
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    const res = await fetchJsonCached(url, 60);
    assert.equal(res.cache, "stale");
    assert.equal(res.payload.n, 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test("network failure (promise rejection) returns stale cache when available", async () => {
  const url = base + "/fail";
  clearCaches();
  seedCache(url, { state: "IN", n: 2 }, -100);
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const res = await fetchJsonCached(url, 60);
    assert.equal(res.cache, "stale");
    assert.equal(res.payload.n, 2);
  } finally {
    globalThis.fetch = orig;
  }
});

test("failure without cache propagates the error", async () => {
  const url = base + "/nocache";
  clearCaches();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("timeout");
  };
  try {
    await assert.rejects(() => fetchJsonCached(url, 60), /timeout/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("a failed uncached request clears its in-flight entry so a retry succeeds", async () => {
  const url = base + "/retry";
  clearCaches();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("timeout");
  };
  await assert.rejects(() => fetchJsonCached(url, 60), /timeout/);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ n: 5 }) });
  try {
    const res = await fetchJsonCached(url, 60);
    assert.equal(res.cache, "miss");
    assert.equal(res.payload.n, 5);
  } finally {
    globalThis.fetch = orig;
  }
});

test("concurrent identical requests make a single upstream fetch", async () => {
  const url = base + "/concurrent";
  clearCaches();
  let calls = 0;
  let resolveFetch;
  const pending = new Promise((r) => (resolveFetch = r));
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return pending;
  };
  try {
    const a = fetchJsonCached(url, 60);
    const b = fetchJsonCached(url, 60);
    resolveFetch({ ok: true, status: 200, json: async () => ({ n: 7 }) });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(calls, 1, "single-flight should collapse to one upstream fetch");
    assert.equal(ra.cache, "miss");
    assert.equal(rb.cache, "miss");
    assert.equal(ra.payload.n, 7);
    assert.equal(rb.payload.n, 7);
  } finally {
    globalThis.fetch = orig;
  }
});

test("fresh cache short-circuits without hitting the network", async () => {
  const url = base + "/fresh";
  clearCaches();
  seedCache(url, { state: "IN", n: 9 }, 600);
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const res = await fetchJsonCached(url, 60);
    assert.equal(res.cache, "hit");
    assert.equal(res.payload.n, 9);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test("daily request limit falls back to stale cache instead of erroring", async () => {
  const url = base + "/limit";
  clearCaches();
  seedCache(url, { state: "IN", n: 3 }, -100);
  const dayStart = Math.floor(Date.UTC(new Date(now() * 1000).getUTCFullYear(), new Date(now() * 1000).getUTCMonth(), new Date(now() * 1000).getUTCDate()) / 1000);
  db.prepare("INSERT INTO espn_request_log(cache_key, requested_at) VALUES (?,?)").run(sha(url), dayStart + 1);
  db.prepare("INSERT INTO espn_request_log(cache_key, requested_at) VALUES (?,?)").run(sha(url), dayStart + 1);
  // Exhaust the daily budget (default 2000 in config) so the limit branch triggers.
  while (db.prepare("SELECT COUNT(*) c FROM espn_request_log WHERE requested_at >= ?").get(dayStart).c < 2000) {
    db.prepare("INSERT INTO espn_request_log(cache_key, requested_at) VALUES (?,?)").run(sha(url), dayStart + 1);
  }
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("should not be called");
  };
  try {
    const res = await fetchJsonCached(url, 60);
    assert.equal(res.cache, "stale");
    assert.equal(res.payload.n, 3);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

for (const failure of ["timeout", "body"]) {
  test(`${failure} failure returns stale cache with its original fetchedAt`, async () => {
    clearCaches();
    const url = `${base}/${failure}`;
    seedCache(url, { n: 10 }, -100);
    const stored = db.prepare("SELECT fetched_at FROM espn_cache WHERE cache_key = ?").get(sha(url));
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError");
      return { ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } };
    };
    try {
      const result = await fetchJsonCached(url, 60);
      assert.equal(result.cache, "stale");
      assert.equal(result.payload.n, 10);
      assert.equal(result.fetchedAt, stored.fetched_at);
    } finally {
      globalThis.fetch = orig;
    }
  });
}

for (const operation of ["read", "write"]) {
  test(`database ${operation} errors propagate despite stale cache, and allow retry`, async () => {
    clearCaches();
    const url = `${base}/db-${operation}`;
    seedCache(url, { n: 11 }, -100);
    const originalPrepare = db.prepare;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: true, json: async () => ({ n: 12 }) };
    };
    const failure = new Error(`Database ${operation} failed`);
    db.prepare = function (sql) {
      const target = operation === "read" ? "SELECT COUNT(*) AS total FROM espn_request_log" : "INSERT INTO espn_cache";
      if (sql.includes(target)) throw failure;
      return originalPrepare.call(this, sql);
    };
    try {
      await assert.rejects(fetchJsonCached(url, 60), (error) => error === failure);
      assert.equal(calls, operation === "read" ? 0 : 1);
      db.prepare = originalPrepare;
      const result = await fetchJsonCached(url, 60);
      assert.equal(result.cache, "miss");
      assert.equal(result.payload.n, 12);
    } finally {
      db.prepare = originalPrepare;
      globalThis.fetch = originalFetch;
    }
  });
}

test("EXPLAIN QUERY PLAN uses the new created_at index", () => {
  const rows = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM espn_game_snapshots WHERE created_at < ?").all(1000);
  const text = rows.map((r) => r.detail).join(" | ");
  assert.match(text, /idx_espn_snapshots_created/, `expected created_at index in plan: ${text}`);
});
