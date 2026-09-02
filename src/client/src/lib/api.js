export async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 401 && !path.startsWith("/api/public")) {
    window.history.replaceState(null, "", "/login");
    window.dispatchEvent(new Event("locationchange"));
  }
  return response;
}
