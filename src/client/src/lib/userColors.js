const usernamePalette = [
  "#34d399",
  "#60a5fa",
  "#f472b6",
  "#fbbf24",
  "#22d3ee",
  "#a78bfa",
  "#fb7185",
  "#bef264",
  "#f97316",
  "#38bdf8",
  "#c084fc",
  "#2dd4bf",
];

export function usernameColor(username = "") {
  const value = String(username).trim().toLowerCase();
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return usernamePalette[hash % usernamePalette.length];
}
