export function newestSportsSummary(current, incoming) {
  if (!incoming) return current;
  if (!current) return incoming;
  const currentFetchedAt = Number(current.fetchedAt || 0);
  const incomingFetchedAt = Number(incoming.fetchedAt || 0);
  if (currentFetchedAt && incomingFetchedAt && incomingFetchedAt <= currentFetchedAt) return current;
  return incoming;
}

export function appendUniqueChatMessage(messages, incoming, limit = 80) {
  if (!incoming) return messages;
  if (incoming.id != null && messages.some((message) => String(message.id) === String(incoming.id))) return messages;
  return [...messages.slice(-(limit - 1)), incoming];
}
