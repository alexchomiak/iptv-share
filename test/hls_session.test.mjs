import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHlsSessionDirectory } from "../src/server/stream.js";

test("replacement HLS sessions use separate directories", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "iptv-share-session-test-"));
  try {
    const oldDirectory = createHlsSessionDirectory("same-session", temporaryRoot);
    const replacementDirectory = createHlsSessionDirectory("same-session", temporaryRoot);
    assert.notEqual(oldDirectory, replacementDirectory);
    fs.writeFileSync(path.join(replacementDirectory, "index.m3u8"), "#EXTM3U\n");
    fs.rmSync(oldDirectory, { recursive: true, force: true });
    assert.equal(fs.existsSync(path.join(replacementDirectory, "index.m3u8")), true);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
