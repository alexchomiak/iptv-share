export function shouldEndOpenSportsStream(entitlement) {
  if (!entitlement || entitlement.streamable || !entitlement.usesSportsClock) return false;
  return String(entitlement.source || "").startsWith("sports-final");
}
