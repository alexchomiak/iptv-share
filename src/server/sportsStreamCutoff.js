export function streamCutoffWindow(entitlement) {
  const event = entitlement?.event || entitlement;
  if (!event?.espn_event_id && !entitlement?.usesSportsClock) return event;
  return { ...event, open_ended_cutoff: true };
}

export function shouldEndOpenSportsStream(entitlement) {
  if (!entitlement || entitlement.streamable || !entitlement.usesSportsClock) return false;
  return String(entitlement.source || "").startsWith("sports-final");
}
