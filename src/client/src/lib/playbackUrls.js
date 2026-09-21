export function browserPlaybackUrl(value, origin = "http://localhost") {
  if (!value) return value;
  try {
    const url = new URL(value, origin);
    url.searchParams.delete("viewer");
    url.searchParams.delete("vsig");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}

export function nativeHlsPlaybackUrl(value, origin = "http://localhost") {
  if (!value) return value;
  const url = new URL(value, origin);
  url.searchParams.set("compat", "1");
  return `${url.pathname}${url.search}${url.hash}`;
}
