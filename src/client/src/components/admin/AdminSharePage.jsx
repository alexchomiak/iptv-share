import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.js";
import { navigate } from "../../lib/navigation.js";
import { eventEnd, eventStart, formatDateTime } from "../../lib/time.js";
import StaticCountdown from "../share/Countdown.jsx";
import Player from "../share/Player.jsx";
import ShareChat from "../share/ShareChat.jsx";
import SportsPanel from "../share/SportsPanel.jsx";
import { usernameColor } from "../../lib/userColors.js";
import PastGames from "../share/PastGames.jsx";

function fullUrl(url) {
  return url?.startsWith("/") ? `${window.location.origin}${url}` : url;
}

function viewerStatus(viewer) {
  if (viewer.kicked) return "Removed";
  if (viewer.streaming) return "Streaming";
  if (viewer.waiting) return "Waiting";
  if (viewer.online) return "Online";
  return "Offline";
}

function ViewerControlSection({ title, viewers, defaultOpen = false, onKick, onRestore }) {
  return (
    <details className="adminViewerSection" defaultOpen={defaultOpen}>
      <summary>{title} <span>{viewers.length}</span></summary>
      <div>
        {viewers.length === 0 && <p className="emptyState">None</p>}
        {viewers.map((viewer) => (
          <article key={viewer.id}>
            <span><strong style={{ color: usernameColor(viewer.username) }}>{viewer.username}</strong> {viewerStatus(viewer)}</span>
            {viewer.kicked
              ? <button type="button" onClick={() => onRestore(viewer.id)}>Restore</button>
              : <button type="button" className="danger" onClick={() => onKick(viewer.id)}>Kick</button>}
          </article>
        ))}
      </div>
    </details>
  );
}

function AdminSharePage({ shareRef }) {
  const [share, setShare] = useState(null);
  const [message, setMessage] = useState("");
  const [settingsForm, setSettingsForm] = useState({
    title: "",
    description: "",
    icon: "",
    backgroundImage: "",
    discordWebhookUrl: "",
    password: "",
    clearPassword: false,
    maxViewers: "",
  });
  const [viewerToken, setViewerToken] = useState("");
  const [streamActive, setStreamActive] = useState(false);
  const [viewers, setViewers] = useState([]);
  const [sportsSummary, setSportsSummary] = useState(null);
  const [sportsMessage, setSportsMessage] = useState("");
  const [clockNow, setClockNow] = useState(() => Date.now());
  const handleViewerToken = useCallback((token) => setViewerToken(token), []);
  const handlePresence = useCallback((nextViewers) => setViewers(nextViewers), []);

  function sportsSummaryIsFinal(summary) {
    return Boolean(summary?.completed)
      || String(summary?.state || "").toLowerCase() === "post"
      || String(summary?.status || "").toLowerCase().includes("final")
      || String(summary?.statusDetail || "").toLowerCase().includes("final");
  }

  async function loadShare({ hydrateViewers = false } = {}) {
    const response = await api(`/api/admin/share/${encodeURIComponent(shareRef)}`);
    if (!response.ok) {
      setMessage("Share not found.");
      return;
    }
    const payload = await response.json();
    setShare(payload.share);
    setSettingsForm({
      title: payload.share.title || "",
      description: payload.share.description || "",
      icon: payload.share.icon || "",
      backgroundImage: payload.share.background_image || "",
      discordWebhookUrl: payload.share.discord_webhook_url || "",
      password: "",
      clearPassword: false,
      maxViewers: payload.share.max_viewers || "",
    });
    if (hydrateViewers) setViewers(payload.share.viewers || []);
  }

  useEffect(() => {
    setViewers([]);
    loadShare({ hydrateViewers: true });
  }, [shareRef]);

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!share) return undefined;
    const current = Math.floor(Date.now() / 1000);
    const schedule = [...(share.events || share.programs || [])].sort((a, b) => eventStart(a) - eventStart(b));
    const nextEvent = schedule.find((program) => eventStart(program) > current);
    const activeEvent = schedule.find((program) => program.id === share.active_event_id || program.id === share.active_program_id);
    const liveEvent = activeEvent || schedule.find((program) => eventStart(program) <= current && current <= eventEnd(program));
    const reloadAt = share.stream_url && activeEvent?.espn
      ? current + 60
      : share.stream_url
        ? (eventEnd(liveEvent || share) + 305)
      : eventStart(nextEvent || share);
    if (!Number(reloadAt) || reloadAt <= current) return undefined;
    const timer = setTimeout(loadShare, Math.max(1000, (reloadAt - current) * 1000 + 1000));
    return () => clearTimeout(timer);
  }, [share, shareRef]);

  useEffect(() => {
    if (!share || share.kind !== "static" || !share.active_event_id || !streamActive) {
      setSportsSummary(null);
      return undefined;
    }
    const active = (share.events || []).find((event) => event.id === share.active_event_id);
    if (!active?.espn?.id) {
      setSportsSummary(null);
      return undefined;
    }
    let cancelled = false;
    let timer = null;
    async function loadSportsSummary() {
      const response = await api(`/api/admin/share/${encodeURIComponent(shareRef)}/sports-summary?event=${active.id}`);
      const payload = await response.json();
      if (cancelled) return;
      if (response.ok) {
        setSportsSummary(payload.summary ? { ...payload.summary, refreshSeconds: payload.refreshSeconds, fetchedAt: payload.fetchedAt } : null);
        setSportsMessage("");
        if (sportsSummaryIsFinal(payload.summary)) loadShare();
        timer = setTimeout(loadSportsSummary, Math.max(30, Number(payload.refreshSeconds || 60)) * 1000);
      } else {
        setSportsMessage(payload.error || "Live sports data unavailable.");
        timer = setTimeout(loadSportsSummary, 60000);
      }
    }
    loadSportsSummary();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [share, shareRef, streamActive]);

  async function saveShareSettings(event) {
    event.preventDefault();
    if (!share) return;
    const endpoint = share.kind === "static" ? `/api/static-shares/${share.id}` : `/api/shares/${share.id}`;
    const body = share.kind === "static"
      ? settingsForm
      : { maxViewers: settingsForm.maxViewers };
    const response = await api(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Could not save share settings.");
      return;
    }
    setMessage("Share settings saved.");
    await loadShare();
  }

  async function kickViewer(viewerId) {
    if (!share) return;
    await api(`/api/share-viewers/${share.kind}/${share.id}/${viewerId}/kick`, { method: "POST" });
  }

  async function unkickViewer(viewerId) {
    if (!share) return;
    await api(`/api/share-viewers/${share.kind}/${share.id}/${viewerId}/unkick`, { method: "POST" });
  }

  async function removeScheduledEvent(eventId) {
    if (!share || share.kind !== "static") return;
    await api(`/api/static-shares/${share.id}/events/${eventId}`, { method: "DELETE" });
    await loadShare();
  }

  if (!share) {
    return (
      <main className="shareShell">
        <section className="shareHero">
          <div>
            <h1>Share Admin</h1>
            <p>{message || "Loading share..."}</p>
          </div>
          <button type="button" onClick={() => navigate("/admin")}>All Shares</button>
        </section>
      </main>
    );
  }

  const isStaticShare = share.kind === "static";
  const schedule = share.events || share.programs || [];
  const sortedSchedule = [...schedule].sort((a, b) => eventStart(a) - eventStart(b));
  const nowSeconds = Math.floor(clockNow / 1000);
  const serverLiveEvent = sortedSchedule.find((program) => program.id === share.active_event_id);
  const liveEvent = isStaticShare
    ? serverLiveEvent
    : sortedSchedule.find((program) => eventStart(program) <= nowSeconds && nowSeconds <= eventEnd(program));
  const nextEvent = sortedSchedule.find((program) => eventStart(program) > nowSeconds);
  const countdownSeconds = nextEvent ? Math.max(0, eventStart(nextEvent) - nowSeconds) : 0;
  const hasWindow = Number(share.starts_at) && Number(share.ends_at);
  const starts = hasWindow ? new Date(share.starts_at * 1000) : null;
  const ends = hasWindow ? new Date(share.ends_at * 1000) : null;
  const state = !hasWindow ? "Schedule" : share.server_now < share.starts_at ? "Starts" : share.server_now <= share.ends_at ? "Live now" : "Ended";
  const onlineViewers = viewers.filter((viewer) => !viewer.kicked && viewer.online);
  const offlineViewers = viewers.filter((viewer) => !viewer.kicked && !viewer.online);
  const kickedViewers = viewers.filter((viewer) => viewer.kicked);

  return (
    <main
      className={`shareShell adminWatchShell ${isStaticShare ? "staticShareShell" : ""}`}
      style={isStaticShare && share.background_image_url ? { "--static-share-bg": `url("${share.background_image_url}")` } : undefined}
    >
      <section className={`shareHero ${isStaticShare ? "staticHero" : ""}`}>
        {isStaticShare && share.icon_url && <img className="staticShareIcon" src={share.icon_url} alt="" />}
        <div>
          <h1>{share.title || "Shared IPTV Window"}</h1>
          <p>{isStaticShare ? share.description || "Static schedule" : share.channel_name}</p>
        </div>
        <div className="toolbar">
          <a className="buttonLink" href={fullUrl(share.url)} target="_blank" rel="noreferrer">Public Page</a>
          <button type="button" onClick={() => navigate("/admin")}>All Shares</button>
        </div>
        {!isStaticShare && <time>{hasWindow ? `${state}: ${formatDateTime.format(starts)} - ${formatDateTime.format(ends)}` : state}</time>}
      </section>

      <section className="adminWatchBar">
        <form onSubmit={saveShareSettings}>
          {share.kind === "static" && (
            <>
              <label>
                Title
                <input value={settingsForm.title} onChange={(event) => setSettingsForm({ ...settingsForm, title: event.target.value })} />
              </label>
              <label>
                Description
                <input value={settingsForm.description} onChange={(event) => setSettingsForm({ ...settingsForm, description: event.target.value })} />
              </label>
              <label>
                Icon URL
                <input value={settingsForm.icon} onChange={(event) => setSettingsForm({ ...settingsForm, icon: event.target.value })} placeholder="https://..." />
              </label>
              <label>
                Background URL
                <input value={settingsForm.backgroundImage} onChange={(event) => setSettingsForm({ ...settingsForm, backgroundImage: event.target.value })} placeholder="https://..." />
              </label>
              <label>
                Discord webhook
                <input value={settingsForm.discordWebhookUrl} onChange={(event) => setSettingsForm({ ...settingsForm, discordWebhookUrl: event.target.value })} type="url" placeholder="Optional Discord webhook URL" />
              </label>
              <label>
                New password
                <input
                  value={settingsForm.password}
                  onChange={(event) => setSettingsForm({ ...settingsForm, password: event.target.value, clearPassword: false })}
                  type="password"
                  placeholder={share.has_password ? "Leave blank to keep current" : "Optional"}
                />
              </label>
            </>
          )}
          <label>
            Max concurrent streamers
            <input value={settingsForm.maxViewers} onChange={(event) => setSettingsForm({ ...settingsForm, maxViewers: event.target.value })} type="number" min="0" placeholder="Unlimited" />
          </label>
          {share.kind === "static" && (
            <label className="checkboxLabel">
              <input
                checked={settingsForm.clearPassword}
                onChange={(event) => setSettingsForm({ ...settingsForm, clearPassword: event.target.checked, password: "" })}
                type="checkbox"
                disabled={!share.has_password}
              />
              Remove password
            </label>
          )}
          <button type="submit" className="primary">Save Settings</button>
        </form>
        <div>
          <strong>{viewers.filter((viewer) => viewer.streaming).length}</strong>
          <span>streaming</span>
        </div>
        <div>
          <strong>{viewers.filter((viewer) => viewer.waiting).length}</strong>
          <span>waiting</span>
        </div>
        <div>
          <strong>{viewers.filter((viewer) => viewer.kicked).length}</strong>
          <span>removed</span>
        </div>
        {message && <p>{message}</p>}
      </section>

      <section className="watchLayout">
        <div className="watchPrimary">
          {isStaticShare && !share.stream_url && (
            <StaticCountdown nextEvent={nextEvent} liveEvent={liveEvent} seconds={countdownSeconds} />
          )}
          {share.stream_url && (
            <Player
              src={share.stream_url}
              hlsSrc={share.hls_url}
              kind={share.stream_kind}
              viewerToken={viewerToken}
              onPlaybackActive={setStreamActive}
            />
          )}
          {(sportsSummary || sportsMessage) && <SportsPanel summary={sportsSummary} message={sportsMessage} />}
        </div>
        <ShareChat
          slug={share.slug}
          locked={false}
          admin
          onViewerToken={handleViewerToken}
          onSlotStatus={() => {}}
          onPresence={handlePresence}
          streamActive={false}
          onKickViewer={kickViewer}
          onUnkickViewer={unkickViewer}
        />
      </section>

      <section className="adminViewerStrip">
        <h2>Viewer Control</h2>
        <ViewerControlSection title="Online Users" viewers={onlineViewers} defaultOpen onKick={kickViewer} onRestore={unkickViewer} />
        <ViewerControlSection title="Offline Users" viewers={offlineViewers} onKick={kickViewer} onRestore={unkickViewer} />
        <ViewerControlSection title="Kicked Users" viewers={kickedViewers} onKick={kickViewer} onRestore={unkickViewer} />
      </section>

      <section className={`programList ${isStaticShare ? "adminScheduleProgramList" : ""}`}>
        {sortedSchedule.map((program) => {
          const media = program.icon_url || program.icon;
          const isLive = share.active_event_id === program.id || share.active_program_id === program.id;
          return (
            <article key={program.id} className={`programRow ${media ? "" : "noMedia"} ${isLive ? "live" : ""}`}>
              {media && <img src={media} alt="" />}
              <div>
                <strong>{program.title}</strong>
                <span>{formatDateTime.format(new Date(eventStart(program) * 1000))} - {formatDateTime.format(new Date(eventEnd(program) * 1000))}</span>
                {program.espn && (
                  <div className="sportsLinked">
                    {program.espn.away?.logo && <img src={program.espn.away.logo} alt="" />}
                    <small>ESPN: {program.espn.shortName || program.espn.name}</small>
                    {program.espn.home?.logo && <img src={program.espn.home.logo} alt="" />}
                  </div>
                )}
                <p>{program.description}</p>
              </div>
              {isStaticShare && (
                <button type="button" className="danger" onClick={() => removeScheduledEvent(program.id)}>Remove</button>
              )}
            </article>
          );
        })}
      </section>
      {isStaticShare && <PastGames games={share.pastGames || []} />}
    </main>
  );
}

export default AdminSharePage;
