const SNAPSHOT_CLEANUP_INTERVAL_SECONDS = 60;

let lastSnapshotCleanupAt = 0;

export function __resetSnapshotCleanup() {
  lastSnapshotCleanupAt = 0;
}

export function __lastSnapshotCleanupAt() {
  return lastSnapshotCleanupAt;
}

export function cleanExpiredEspnSnapshots(db, now, retentionSeconds = 86400) {
  const current = now();
  if (current - lastSnapshotCleanupAt < SNAPSHOT_CLEANUP_INTERVAL_SECONDS) return false;
  try {
    db.prepare("DELETE FROM espn_game_snapshots WHERE created_at < ?").run(current - retentionSeconds);
    lastSnapshotCleanupAt = current;
    return true;
  } catch {
    return false;
  }
}
