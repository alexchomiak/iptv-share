export const formatTime = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
export const formatDateTime = new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" });

export function toLocalInput(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value) {
  return Math.floor(new Date(value).getTime() / 1000);
}

export function eventStart(event) {
  return Number(event.start_at ?? event.starts_at ?? 0);
}

export function eventEnd(event) {
  return Number(event.end_at ?? event.ends_at ?? 0);
}
