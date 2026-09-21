import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../src/server/config.js";
import { createHlsSessionDirectory, hlsCleanupCutoffAt, hlsCodecPlan } from "../src/server/stream.js";

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

test("Apple compatibility HLS encodes H.264 and AAC with aligned keyframes", () => {
  const plan = hlsCodecPlan({ video: "hevc", audio: "aac" }, true);
  assert.notEqual(plan.videoMode, "copy");
  assert.equal(plan.audioMode, "aac");
  assert.ok(plan.outputArgs.includes("-c:v"));
  assert.ok(plan.outputArgs.includes("-force_key_frames"));
  assert.ok(plan.outputArgs.includes("expr:gte(t,n_forced*4)"));
  assert.ok(plan.outputArgs.includes("libx264") || plan.outputArgs.includes("h264_vaapi"));
});

test("HLS cleanup deadline remains absolute across repeated checks", () => {
  const startedAt = 1_000_000;
  const cutoffWindow = { ends_at: 1_500 };
  assert.equal(hlsCleanupCutoffAt(startedAt, cutoffWindow), (1_500 + config.shareAutoDeleteSeconds) * 1000);
  assert.equal(hlsCleanupCutoffAt(startedAt, { ends_at: 0 }), startedAt + 15000);
  assert.equal(hlsCleanupCutoffAt(startedAt, { open_ended_cutoff: true }), Infinity);
});
