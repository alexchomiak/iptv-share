function playId(play = {}) {
  return String(play.id || play.playId || "");
}

export function liveSummaryLooksPartial(previous, current) {
  if (!previous || !current) return false;
  const state = String(current.state || "").toLowerCase();
  if (!state || state === "pre") return false;

  const previousLeaders = previous.leaders || [];
  const currentLeaders = current.leaders || [];
  if (previousLeaders.length && !currentLeaders.length) return true;

  const previousScoring = previous.scoringSummary || [];
  const currentScoring = current.scoringSummary || [];
  if (!previousScoring.length || !currentScoring.length) return false;
  const referencePeriod = Number(current.period || 0) || Math.max(...currentScoring.map((play) => Number(play.period?.number ?? play.period ?? 0)));
  if (!referencePeriod) return false;
  const currentIds = new Set(currentScoring.map(playId).filter(Boolean));
  const missingEarlierPeriod = previousScoring.some((play) => {
    const period = Number(play.period?.number ?? play.period ?? 0);
    return period > 0 && period < referencePeriod && !currentIds.has(playId(play));
  });
  const currentOnlyShowsCurrentPeriod = currentScoring.every((play) => Number(play.period?.number ?? play.period ?? 0) >= referencePeriod);
  return missingEarlierPeriod && currentOnlyShowsCurrentPeriod;
}
