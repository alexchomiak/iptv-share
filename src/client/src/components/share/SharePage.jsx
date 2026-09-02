import { useEffect, useState } from "react";
import { eventEnd, eventStart, formatDateTime } from "../../lib/time.js";
import Player from "./Player.jsx";
import SportsPanel from "./SportsPanel.jsx";
import StaticCountdown from "./Countdown.jsx";

function SharePage({ slug }) {
  const [share, setShare] = useState(null);
  const [message, setMessage] = useState("");
  const [sportsSummary, setSportsSummary] = useState(null);
  const [sportsMessage, setSportsMessage] = useState("");
  const [clockNow, setClockNow] = useState(() => Date.now());

  async function loadShare() {
    const response = await fetch(`/api/public/share/${encodeURIComponent(slug)}`);
    const payload = await response.json();
    if (!response.ok) {
      setMessage("Share not found.");
      return;
    }
    setShare(payload.share);
  }

  useEffect(() => {
    fetch(`/api/public/share/${encodeURIComponent(slug)}/open`, { method: "POST" });
    loadShare();
  }, [slug]);

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!share || share.locked || share.kind !== "static" || !share.active_event_id) {
      setSportsSummary(null);
      return undefined;
    }
    const active = (share.events || []).find((event) => event.id === share.active_event_id);
    if (!active?.espn?.id) {
      setSportsSummary(null);
      return undefined;
    }
    let cancelled = false;
    async function loadSportsSummary() {
      const response = await fetch(`/api/public/share/${encodeURIComponent(slug)}/sports-summary?event=${active.id}`);
      const payload = await response.json();
      if (cancelled) return;
      if (response.ok) {
        setSportsSummary({ ...payload.summary, refreshSeconds: payload.refreshSeconds, fetchedAt: payload.fetchedAt });
        setSportsMessage("");
      } else {
        setSportsMessage(payload.error || "Live sports data unavailable.");
      }
    }
    loadSportsSummary();
    const timer = setInterval(loadSportsSummary, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [share, slug]);

  async function unlock(event) {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get("password");
    const response = await fetch(`/api/public/share/${encodeURIComponent(slug)}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (response.ok) loadShare();
    else setMessage("Incorrect password.");
  }

  if (!share) {
    return <main className="shareShell"><h1>{message || "Loading..."}</h1></main>;
  }

  const hasWindow = Number(share.starts_at) && Number(share.ends_at);
  const starts = hasWindow ? new Date(share.starts_at * 1000) : null;
  const ends = hasWindow ? new Date(share.ends_at * 1000) : null;
  const state = !hasWindow ? "Schedule" : share.server_now < share.starts_at ? "Starts" : share.server_now <= share.ends_at ? "Live now" : "Ended";
  const schedule = share.events || share.programs || [];
  const sortedSchedule = [...schedule].sort((a, b) => eventStart(a) - eventStart(b));
  const nowSeconds = Math.floor(clockNow / 1000);
  const liveEvent = sortedSchedule.find((program) => eventStart(program) <= nowSeconds && nowSeconds <= eventEnd(program));
  const nextEvent = sortedSchedule.find((program) => eventStart(program) > nowSeconds);
  const countdownSeconds = nextEvent ? Math.max(0, eventStart(nextEvent) - nowSeconds) : 0;
  const isStaticShare = share.kind === "static";
  const upcomingWindow = !isStaticShare && hasWindow && nowSeconds < share.starts_at
    ? { title: share.title || "Shared IPTV Window", start_at: share.starts_at, end_at: share.ends_at, icon_url: sortedSchedule[0]?.icon_url || sortedSchedule[0]?.icon }
    : null;
  const oneOffCountdownEvent = nextEvent || upcomingWindow;
  const oneOffCountdownSeconds = oneOffCountdownEvent ? Math.max(0, eventStart(oneOffCountdownEvent) - nowSeconds) : 0;

  return (
    <main className={`shareShell ${isStaticShare ? "staticShareShell" : ""}`}>
      <section className={`shareHero ${isStaticShare ? "staticHero" : ""}`}>
        {isStaticShare && share.icon_url && <img className="staticShareIcon" src={share.icon_url} alt="" />}
        <div>
          <h1>{share.title || "Shared IPTV Window"}</h1>
          <p>{isStaticShare ? share.description || "Static schedule" : share.channel_name}</p>
        </div>
        {!isStaticShare && <time>{hasWindow ? `${state}: ${formatDateTime.format(starts)} - ${formatDateTime.format(ends)}` : state}</time>}
      </section>
      {isStaticShare && (!share.stream_url || share.locked) && (
        <StaticCountdown nextEvent={nextEvent} liveEvent={liveEvent} seconds={countdownSeconds} />
      )}
      {!isStaticShare && !share.stream_url && oneOffCountdownEvent && (
        <StaticCountdown nextEvent={oneOffCountdownEvent} seconds={oneOffCountdownSeconds} label="Starts In" />
      )}
      {share.locked && (
        <section className="passwordGate">
          <form onSubmit={unlock}>
            <h2>Password Required</h2>
            <input name="password" type="password" placeholder="Share password" required />
            <button type="submit" className="primary">Unlock Stream</button>
            <p>{message}</p>
          </form>
        </section>
      )}
      {!share.locked && share.stream_url && <Player src={share.stream_url} hlsSrc={share.hls_url} kind={share.stream_kind} />}
      {!share.locked && !share.stream_url && !isStaticShare && !oneOffCountdownEvent && <p className="notLive">This share is not currently in its stream window.</p>}
      {!share.locked && (sportsSummary || sportsMessage) && <SportsPanel summary={sportsSummary} message={sportsMessage} />}
      <section className="programList">
        {sortedSchedule.map((program) => {
          const media = program.icon_url || program.icon;
          const isLive = share.active_event_id === program.id || share.active_program_id === program.id;
          const startsAt = eventStart(program);
          const endsAt = eventEnd(program);
          return (
            <article key={program.id} className={`programRow ${media ? "" : "noMedia"} ${isLive ? "live" : ""}`}>
              {media && <img src={media} alt="" />}
              <div>
                <strong>{program.title}</strong>
                <span>{formatDateTime.format(new Date(startsAt * 1000))} - {formatDateTime.format(new Date(endsAt * 1000))}</span>
                {program.espn && (
                  <div className="sportsLinked">
                    {program.espn.away?.logo && <img src={program.espn.away.logo} alt="" />}
                    <small>ESPN: {program.espn.shortName || program.espn.name}</small>
                    {program.espn.home?.logo && <img src={program.espn.home.logo} alt="" />}
                  </div>
                )}
                <p>{program.description}</p>
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}

export default SharePage;
