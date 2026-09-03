import React, { useEffect, useState } from "react";

function SportsPanel({ summary, message, hideScorecard = false }) {
  if (message && !summary) return <section className="sportsPanel"><p>{message}</p></section>;
  if (summary?.sport === "baseball" || summary?.league === "mlb") return <BaseballPanel summary={summary} hideScorecard={hideScorecard} />;
  return <FootballPanel summary={summary} hideScorecard={hideScorecard} />;
}

function useRelativeTimeTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 30000);
    return () => clearInterval(timer);
  }, []);
}

function FootballPanel({ summary, hideScorecard = false }) {
  const playerGroups = summary?.boxscore?.players || [];
  const competitors = [...(summary?.competitors || [])].sort((a, b) => {
    if (a.homeAway === b.homeAway) return 0;
    return a.homeAway === "away" ? -1 : 1;
  });
  const away = competitors.find((entry) => entry.homeAway === "away") || competitors[0];
  const home = competitors.find((entry) => entry.homeAway === "home") || competitors[1];
  const periodLabels = getPeriodLabels(summary, competitors);

  return (
    <section className="sportsPanel">
      {!hideScorecard && (
        <div className="footballScorecard">
          <ScoreTeamSide entry={away} side="away" compact />
          <b className="footballCenterScore">{away?.score ?? "-"}</b>
          <FootballLineScore summary={summary} away={away} home={home} periodLabels={periodLabels} />
          <b className="footballCenterScore">{home?.score ?? "-"}</b>
          <ScoreTeamSide entry={home} side="home" compact />
        </div>
      )}
      <RefreshNote seconds={summary.refreshSeconds} fetchedAt={summary.fetchedAt} />
      {playerGroups.length > 0 && (
        <div className="footballBoxscore">
          {[away, home].filter(Boolean).map((entry) => {
            const teamStats = playerGroups.find((team) => String(team.team?.id) === String(entry.team?.id))
              || playerGroups.find((team) => team.team?.abbreviation === entry.team?.abbreviation);
            return <FootballTeamBox key={entry.id || entry.team?.abbreviation} competitor={entry} teamStats={teamStats} />;
          })}
        </div>
      )}
    </section>
  );
}

function FootballLineScore({ summary, away, home, periodLabels }) {
  return (
    <div className="gameCenter">
      <span>{gameStatusText(summary)}</span>
      <div className="lineScoreTable" style={{ gridTemplateColumns: `34px repeat(${periodLabels.length}, 26px)` }}>
        <div />
        {periodLabels.map((period) => <b key={period}>{period}</b>)}
        {[away, home].filter(Boolean).map((entry) => (
          <React.Fragment key={entry.id || entry.team?.abbreviation}>
            <strong>{entry.team?.abbreviation || entry.team?.name}</strong>
            {periodLabels.map((_period, index) => (
              <span key={index}>{entry.linescores?.[index]?.value ?? entry.linescores?.[index]?.displayValue ?? "-"}</span>
            ))}
          </React.Fragment>
        ))}
      </div>
      {summary.clock && <small>{summary.clock}</small>}
    </div>
  );
}

function BaseballPanel({ summary, hideScorecard = false }) {
  const playerGroups = summary?.boxscore?.players || [];
  const competitors = [...(summary?.competitors || [])].sort((a, b) => {
    if (a.homeAway === b.homeAway) return 0;
    return a.homeAway === "away" ? -1 : 1;
  });
  const away = competitors.find((entry) => entry.homeAway === "away") || competitors[0];
  const home = competitors.find((entry) => entry.homeAway === "home") || competitors[1];
  const teamTotals = summary?.boxscore?.teams || [];
  const maxInnings = Math.max(9, ...competitors.map((entry) => entry.linescores?.length || 0), Number(summary?.period || 0));
  const inningLabels = Array.from({ length: maxInnings }, (_item, index) => String(index + 1));

  return (
    <section className="sportsPanel baseballPanel">
      {!hideScorecard && (
        <div className="baseballScorecard">
          <ScoreTeamSide entry={away} side="away" />
          <div className="baseballGameCenter">
            <span>{gameStatusText(summary)}</span>
            {summary.situation && !isFinalSummary(summary) && (
              <small>{baseballSituationText(summary.situation)}</small>
            )}
            {summary.clock && <small>{summary.clock}</small>}
          </div>
          <ScoreTeamSide entry={home} side="home" />
        </div>
      )}
      <div className="baseballLineScore">
        <div
          className="lineScoreTable baseballLines"
          style={{ gridTemplateColumns: `54px repeat(${inningLabels.length}, minmax(28px, 1fr)) repeat(3, 34px)` }}
        >
          <div />
          {inningLabels.map((inning) => <b key={inning}>{inning}</b>)}
          <b>R</b>
          <b>H</b>
          <b>E</b>
          {[away, home].filter(Boolean).map((entry) => (
            <React.Fragment key={entry.id || entry.team?.abbreviation}>
              <strong>{entry.team?.abbreviation || entry.team?.name}</strong>
              {inningLabels.map((_inning, index) => (
                <span key={index}>{entry.linescores?.[index]?.value ?? entry.linescores?.[index]?.displayValue ?? "-"}</span>
              ))}
              <b>{entry.score ?? "-"}</b>
              <b>{getBaseballTotal(teamTotals, entry, "hits")}</b>
              <b>{getBaseballTotal(teamTotals, entry, "errors")}</b>
            </React.Fragment>
          ))}
        </div>
      </div>
      <RefreshNote seconds={summary.refreshSeconds} fetchedAt={summary.fetchedAt} />
      {playerGroups.length > 0 && (
        <div className="baseballBoxscore">
          {[away, home].filter(Boolean).map((entry) => {
            const teamStats = playerGroups.find((team) => String(team.team?.id) === String(entry.team?.id))
              || playerGroups.find((team) => team.team?.abbreviation === entry.team?.abbreviation);
            const totals = teamTotals.find((item) => String(item.team?.id) === String(entry.team?.id))
              || teamTotals.find((item) => item.team?.abbreviation === entry.team?.abbreviation);
            return <BaseballTeamBox key={entry.id || entry.team?.abbreviation} competitor={entry} teamStats={teamStats} teamTotals={totals} />;
          })}
        </div>
      )}
    </section>
  );
}

function RefreshNote({ seconds, fetchedAt }) {
  useRelativeTimeTick();
  if (!seconds) {
    return <small className="sportsRefreshNote">{fetchedAt ? `Final stats captured ${formatUpdatedAgo(fetchedAt)}.` : "Final stats snapshot."}</small>;
  }
  return (
    <small className="sportsRefreshNote">
      Stats refresh every {formatRefreshInterval(seconds)}{fetchedAt ? ` · last updated ${formatUpdatedAgo(fetchedAt)}` : ""}.
    </small>
  );
}

function formatRefreshInterval(seconds) {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function formatUpdatedAgo(value) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - Number(value || 0));
  if (diff < 60) return "just now";
  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ago`;
}

function gameStatusText(summary) {
  if (!summary) return "Game";
  if (summary.statusDetail && !/^scheduled/i.test(summary.statusDetail)) return summary.statusDetail;
  if (summary.shortStatusDetail && !/^scheduled/i.test(summary.shortStatusDetail)) return summary.shortStatusDetail;
  if (summary.sport === "baseball" && summary.periodPrefix && summary.displayPeriod) {
    return `${summary.periodPrefix} ${summary.displayPeriod}`;
  }
  return summary.status || "Game";
}

function baseballSituationText(situation) {
  const parts = [];
  if (Number.isFinite(Number(situation.outs))) parts.push(`${situation.outs} out${Number(situation.outs) === 1 ? "" : "s"}`);
  if (Number.isFinite(Number(situation.balls)) && Number.isFinite(Number(situation.strikes))) {
    parts.push(`${situation.balls}-${situation.strikes}`);
  }
  return parts.join(" · ");
}

function isFinalSummary(summary) {
  return summary?.completed || summary?.state === "post" || /final/i.test(summary?.status || "");
}

function getBaseballTotal(teamTotals, entry, name) {
  const team = teamTotals.find((item) => String(item.team?.id) === String(entry.team?.id))
    || teamTotals.find((item) => item.team?.abbreviation === entry.team?.abbreviation);
  const statistic = (team?.statistics || [])
    .flatMap((group) => group.stats || [])
    .find((stat) => stat.name === name || stat.abbreviation?.toLowerCase() === name);
  return statistic?.displayValue ?? statistic?.value ?? "-";
}

function getPeriodLabels(summary, competitors) {
  const regulationPeriods = summary?.league === "ncaamb" ? 2 : 4;
  const lineScoreCount = Math.max(...(competitors || []).map((entry) => entry.linescores?.length || 0), Number(summary?.period || 0), regulationPeriods);
  return Array.from({ length: lineScoreCount }, (_item, index) => {
    const period = index + 1;
    if (summary?.league === "ncaamb" && period <= regulationPeriods) return `${period}H`;
    if (period <= regulationPeriods) return String(period);
    const overtime = period - regulationPeriods;
    return overtime === 1 ? "OT" : `${overtime}OT`;
  });
}

function ScoreTeamSide({ entry, side, compact = false }) {
  if (!entry) return <div />;
  const record = entry.record || entry.records?.find((item) => item.type === "total")?.summary || entry.records?.[0]?.summary || "";
  return (
    <div className={`scoreTeamSide ${side} ${compact ? "compact" : ""}`}>
      {entry.team?.logo && <img src={entry.team.logo} alt="" />}
      <div>
        <strong>{entry.team?.name || entry.team?.abbreviation}</strong>
        {record && <span>{record}</span>}
      </div>
      {!compact && <b>{entry.score ?? "-"}</b>}
    </div>
  );
}

function FootballTeamBox({ competitor, teamStats }) {
  const teamName = competitor.team?.name || competitor.team?.abbreviation || "Team";
  const groups = normalizeStatGroups(teamStats?.statistics || []);
  return (
    <article className="footballTeamBox">
      {groups.map((group) => (
        <div className="statTableWrap" key={group.name}>
          <h3>
            {competitor.team?.logo && <img src={competitor.team.logo} alt="" />}
            {teamName} {group.name}
          </h3>
          <div className="statTable" style={{ gridTemplateColumns: `minmax(150px, 1.5fr) repeat(${group.labels.length}, minmax(46px, 1fr))` }}>
            <strong>{group.rowHeading}</strong>
            {group.labels.map((label) => <b key={label}>{label}</b>)}
            {group.athletes.map((athlete) => (
              <React.Fragment key={`${group.name}-${athlete.id || athlete.name}`}>
                <AthleteName athlete={athlete} />
                {group.labels.map((_label, index) => <span key={index}>{athlete.stats[index] ?? "-"}</span>)}
              </React.Fragment>
            ))}
          </div>
        </div>
      ))}
    </article>
  );
}

function BaseballTeamBox({ competitor, teamStats, teamTotals }) {
  const teamName = competitor.team?.name || competitor.team?.abbreviation || "Team";
  const groups = normalizeStatGroups(teamStats?.statistics || []);
  const hitting = groups.find((group) => ["batting", "hitting"].includes(group.name?.toLowerCase()));
  const pitching = groups.find((group) => group.name?.toLowerCase() === "pitching");
  const remaining = groups.filter((group) => group !== hitting && group !== pitching);

  return (
    <article className="baseballTeamBox">
      {[hitting, pitching, ...remaining].filter(Boolean).map((group) => {
        const totalRow = buildTeamTotalRow(group, teamTotals);
        const rows = totalRow ? [...group.athletes, totalRow] : group.athletes;
        return (
          <div className="statTableWrap" key={group.name}>
            <h3>
              {competitor.team?.logo && <img src={competitor.team.logo} alt="" />}
              {teamName} {group.name === "batting" ? "Hitting" : group.name}
            </h3>
            <div className="statTable baseballStatTable" style={{ gridTemplateColumns: `minmax(150px, 1.5fr) repeat(${group.labels.length}, minmax(38px, 1fr))` }}>
              <strong>{group.rowHeading}</strong>
              {group.labels.map((label) => <b key={label}>{label}</b>)}
              {rows.map((athlete) => (
                <React.Fragment key={`${group.name}-${athlete.id || athlete.name}`}>
                  <AthleteName athlete={athlete} />
                  {group.labels.map((_label, index) => <span key={index}>{athlete.stats[index] ?? "-"}</span>)}
                </React.Fragment>
              ))}
            </div>
          </div>
        );
      })}
    </article>
  );
}

function buildTeamTotalRow(group, teamTotals) {
  const stats = teamTotals?.statistics?.find((item) => item.name?.toLowerCase() === rawGroupName(group.name))?.stats;
  if (!stats?.length || !group.keys?.length) return null;
  const statMap = new Map(stats.map((stat) => [String(stat.name), stat]));
  const values = group.keys.map((key) => displayTeamStat(statMap, key));
  if (values.every((value) => value === "-")) return null;
  return {
    id: `team-${group.name}`,
    name: "TEAM",
    stats: values,
  };
}

function rawGroupName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower === "hitting") return "batting";
  return lower;
}

function displayTeamStat(statMap, key) {
  const normalized = String(key || "");
  if (normalized === "hits-atBats") {
    const hits = statMap.get("hits")?.displayValue ?? statMap.get("hits")?.value;
    const atBats = statMap.get("atBats")?.displayValue ?? statMap.get("atBats")?.value;
    return hits != null && atBats != null ? `${hits}-${atBats}` : "-";
  }
  if (normalized === "pitches-strikes") {
    const pitches = statMap.get("pitches")?.displayValue ?? statMap.get("pitches")?.value;
    const strikes = statMap.get("strikes")?.displayValue ?? statMap.get("strikes")?.value;
    return pitches != null && strikes != null ? `${pitches}-${strikes}` : "-";
  }
  const exact = statMap.get(normalized);
  const fallback = statMap.get(normalized.split(".").at(-1));
  const stat = exact || fallback;
  return stat?.displayValue ?? stat?.value ?? "-";
}

function normalizeStatGroups(groups) {
  return groups
    .filter((group) => group?.labels?.length || group?.athletes?.length)
    .map((group) => ({
      ...group,
      name: normalizeGroupName(group.name),
      labels: group.labels || [],
      athletes: group.athletes || [],
      rowHeading: rowHeadingForGroup(group.name),
    }));
}

function normalizeGroupName(name) {
  if (!name) return "Stats";
  const lower = String(name).toLowerCase();
  if (lower === "batting") return "Hitting";
  return String(name).replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function rowHeadingForGroup(name) {
  const lower = String(name || "").toLowerCase();
  if (lower === "pitching") return "Pitchers";
  if (lower === "batting" || lower === "hitting") return "Hitters";
  return "Players";
}

function AthleteName({ athlete }) {
  const details = [athlete.position, athlete.jersey ? `#${athlete.jersey}` : "", athlete.didNotPlay ? athlete.reason || "DNP" : ""].filter(Boolean);
  return (
    <strong className={athlete.didNotPlay ? "athleteName didNotPlay" : "athleteName"}>
      <span>{athlete.name}</span>
      {details.length > 0 && <small>{details.join(" ")}</small>}
    </strong>
  );
}

function describeVideoError(video, label) {
  const error = video.error;
  if (!error) return `${label} playback failed.`;
  const names = {
    1: "MEDIA_ERR_ABORTED",
    2: "MEDIA_ERR_NETWORK",
    3: "MEDIA_ERR_DECODE",
    4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
  };
  return `${label} playback failed: ${names[error.code] || "MEDIA_ERR_UNKNOWN"} (${error.code})${error.message ? ` / ${error.message}` : ""}`;
}

function attachHlsJs(video, source, setMessage) {
  const hls = new Hls({
    lowLatencyMode: false,
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    liveSyncDurationCount: 6,
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) setMessage(`HLS playback failed: ${data.details || data.type}`);
  });
  hls.loadSource(source);
  hls.attachMedia(video);
  return () => hls.destroy();
}

function attachNativeVideo(video, source) {
  video.src = source;
  video.load();
  return () => {};
}

function attachMpegTs(video, source, setMessage) {
  const player = mpegts.createPlayer(
    {
      type: "mse",
      isLive: true,
      url: source,
      cors: false,
      withCredentials: true,
    },
    {
      enableWorker: false,
      enableStashBuffer: true,
      stashInitialSize: 4 * 1024 * 1024,
      lazyLoad: false,
      deferLoadAfterSourceOpen: true,
      liveBufferLatencyChasing: false,
      liveBufferLatencyMaxLatency: 20,
      liveBufferLatencyMinRemain: 8,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 300,
      autoCleanupMinBackwardDuration: 120,
    },
  );
  player.on(mpegts.Events.ERROR, (type, detail, info) => {
    const isRecoverableMseNoise =
      detail === mpegts.ErrorDetails?.MEDIA_MSE_ERROR &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    if (!isRecoverableMseNoise) {
      const cleanInfo = typeof info === "string" ? info : info?.msg || info?.message || "";
      setMessage(`MPEG-TS playback failed: ${[type, detail, cleanInfo].filter(Boolean).join(" / ") || "stream error"}`);
    }
  });
  player.attachMediaElement(video);
  player.load();
  return () => {
    player.unload();
    player.detachMediaElement();
    player.destroy();
  };
}

export default SportsPanel;
