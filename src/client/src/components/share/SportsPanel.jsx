import React from "react";

function SportsPanel({ summary, message }) {
  if (message && !summary) return <section className="sportsPanel"><p>{message}</p></section>;
  if (summary?.sport === "baseball" || summary?.league === "mlb") return <BaseballPanel summary={summary} />;
  return <FootballPanel summary={summary} />;
}

function FootballPanel({ summary }) {
  const playerGroups = summary?.boxscore?.players || [];
  const competitors = [...(summary?.competitors || [])].sort((a, b) => {
    if (a.homeAway === b.homeAway) return 0;
    return a.homeAway === "away" ? -1 : 1;
  });
  const away = competitors.find((entry) => entry.homeAway === "away") || competitors[0];
  const home = competitors.find((entry) => entry.homeAway === "home") || competitors[1];
  const periodLabels = ["1", "2", "3", "4"];

  return (
    <section className="sportsPanel">
      <div className="footballScorecard">
        <ScoreTeamSide entry={away} side="away" compact />
        <b className="footballCenterScore">{away?.score ?? "-"}</b>
        <FootballLineScore summary={summary} away={away} home={home} periodLabels={periodLabels} />
        <b className="footballCenterScore">{home?.score ?? "-"}</b>
        <ScoreTeamSide entry={home} side="home" compact />
      </div>
      <RefreshNote seconds={summary.refreshSeconds} />
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
      <span>{summary.status || "Game"}</span>
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

function BaseballPanel({ summary }) {
  const playerGroups = summary?.boxscore?.players || [];
  const competitors = [...(summary?.competitors || [])].sort((a, b) => {
    if (a.homeAway === b.homeAway) return 0;
    return a.homeAway === "away" ? -1 : 1;
  });
  const away = competitors.find((entry) => entry.homeAway === "away") || competitors[0];
  const home = competitors.find((entry) => entry.homeAway === "home") || competitors[1];
  const teamTotals = summary?.boxscore?.teams || [];
  const maxInnings = Math.max(9, ...competitors.map((entry) => entry.linescores?.length || 0));
  const inningLabels = Array.from({ length: maxInnings }, (_item, index) => String(index + 1));

  return (
    <section className="sportsPanel baseballPanel">
      <div className="baseballScorecard">
        <ScoreTeamSide entry={away} side="away" />
        <div className="baseballGameCenter">
          <span>{summary.status || "Game"}</span>
          {summary.clock && <small>{summary.clock}</small>}
        </div>
        <ScoreTeamSide entry={home} side="home" />
      </div>
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
      <RefreshNote seconds={summary.refreshSeconds} />
      {playerGroups.length > 0 && (
        <div className="baseballBoxscore">
          {[away, home].filter(Boolean).map((entry) => {
            const teamStats = playerGroups.find((team) => String(team.team?.id) === String(entry.team?.id))
              || playerGroups.find((team) => team.team?.abbreviation === entry.team?.abbreviation);
            return <BaseballTeamBox key={entry.id || entry.team?.abbreviation} competitor={entry} teamStats={teamStats} />;
          })}
        </div>
      )}
    </section>
  );
}

function RefreshNote({ seconds }) {
  return <small className="sportsRefreshNote">Stats refresh every {formatRefreshInterval(seconds || 60)}.</small>;
}

function formatRefreshInterval(seconds) {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function getBaseballTotal(teamTotals, entry, name) {
  const team = teamTotals.find((item) => String(item.team?.id) === String(entry.team?.id))
    || teamTotals.find((item) => item.team?.abbreviation === entry.team?.abbreviation);
  const statistic = (team?.statistics || [])
    .flatMap((group) => group.stats || [])
    .find((stat) => stat.name === name || stat.abbreviation?.toLowerCase() === name);
  return statistic?.displayValue ?? statistic?.value ?? "-";
}

function ScoreTeamSide({ entry, side, compact = false }) {
  if (!entry) return <div />;
  const record = entry.records?.find((item) => item.type === "total")?.summary || entry.records?.[0]?.summary || "";
  return (
    <div className={`scoreTeamSide ${side} ${compact ? "compact" : ""}`}>
      {entry.team?.logo && <img src={entry.team.logo} alt="" />}
      <div>
        <strong>{entry.team?.name || entry.team?.abbreviation}</strong>
        {record && <span>{record} {side === "away" ? "Away" : "Home"}</span>}
      </div>
      {!compact && <b>{entry.score ?? "-"}</b>}
    </div>
  );
}

function FootballTeamBox({ competitor, teamStats }) {
  const teamName = competitor.team?.name || competitor.team?.abbreviation || "Team";
  return (
    <article className="footballTeamBox">
      {(teamStats?.statistics || []).map((group) => (
        <div className="statTableWrap" key={group.name}>
          <h3>
            {competitor.team?.logo && <img src={competitor.team.logo} alt="" />}
            {teamName} {group.name}
          </h3>
          <div className="statTable" style={{ gridTemplateColumns: `minmax(150px, 1.5fr) repeat(${group.labels.length}, minmax(46px, 1fr))` }}>
            <strong />
            {group.labels.map((label) => <b key={label}>{label}</b>)}
            {group.athletes.map((athlete) => (
              <React.Fragment key={`${group.name}-${athlete.name}`}>
                <strong>{athlete.name}</strong>
                {group.labels.map((_label, index) => <span key={index}>{athlete.stats[index] ?? "-"}</span>)}
              </React.Fragment>
            ))}
          </div>
        </div>
      ))}
    </article>
  );
}

function BaseballTeamBox({ competitor, teamStats }) {
  const teamName = competitor.team?.name || competitor.team?.abbreviation || "Team";
  const groups = teamStats?.statistics || [];
  const hitting = groups.find((group) => group.name?.toLowerCase() === "batting") || groups.find((group) => group.name?.toLowerCase() === "hitting");
  const pitching = groups.find((group) => group.name?.toLowerCase() === "pitching");
  const remaining = groups.filter((group) => group !== hitting && group !== pitching);

  return (
    <article className="baseballTeamBox">
      {[hitting, pitching, ...remaining].filter(Boolean).map((group) => (
        <div className="statTableWrap" key={group.name}>
          <h3>
            {competitor.team?.logo && <img src={competitor.team.logo} alt="" />}
            {teamName} {group.name === "batting" ? "Hitting" : group.name}
          </h3>
          <div className="statTable baseballStatTable" style={{ gridTemplateColumns: `minmax(150px, 1.5fr) repeat(${group.labels.length}, minmax(38px, 1fr))` }}>
            <strong>{group.name === "pitching" ? "Pitchers" : "Hitters"}</strong>
            {group.labels.map((label) => <b key={label}>{label}</b>)}
            {group.athletes.map((athlete) => (
              <React.Fragment key={`${group.name}-${athlete.name}`}>
                <strong>{athlete.name}</strong>
                {group.labels.map((_label, index) => <span key={index}>{athlete.stats[index] ?? "-"}</span>)}
              </React.Fragment>
            ))}
          </div>
        </div>
      ))}
    </article>
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
