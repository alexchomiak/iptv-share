export function staticHlsSegmentIsStreamable(event, snapshot, hasActiveSession) {
  if (snapshot?.streamable) return true;
  return Boolean(event?.espn_event_id && hasActiveSession && !String(snapshot?.source || "").startsWith("sports-final"));
}
