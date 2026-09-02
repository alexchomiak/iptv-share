import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import Hls from "hls.js";
import mpegts from "mpegts.js";
import "./styles.css";

const formatTime = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
const formatDateTime = new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" });

function toLocalInput(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value) {
  return Math.floor(new Date(value).getTime() / 1000);
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 401 && !path.startsWith("/api/public")) {
    window.history.replaceState(null, "", "/login");
    window.dispatchEvent(new Event("locationchange"));
  }
  return response;
}

function useLocationPath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    window.addEventListener("locationchange", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("locationchange", update);
    };
  }, []);
  return path;
}

function navigate(path) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event("locationchange"));
}

function Login() {
  const [message, setMessage] = useState("");

  async function submit(event) {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.ok) navigate("/");
    else setMessage("Invalid username or password.");
  }

  return (
    <main className="loginPage">
      <form className="loginCard" onSubmit={submit}>
        <h1>IPTV Share</h1>
        <label>
          Username
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit">Log in</button>
        <p>{message}</p>
      </form>
    </main>
  );
}

function AppGuide() {
  const initialStart = useMemo(() => toLocalInput(new Date(Date.now() - 30 * 60 * 1000)), []);
  const initialEnd = useMemo(() => toLocalInput(new Date(Date.now() + 24 * 60 * 60 * 1000)), []);
  const [channels, setChannels] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [status, setStatus] = useState("Loading guide...");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("");
  const [rangeStart, setRangeStart] = useState(initialStart);
  const [rangeEnd, setRangeEnd] = useState(initialEnd);
  const [selectedChannelId, setSelectedChannelId] = useState(null);
  const [selectedProgramIds, setSelectedProgramIds] = useState(new Set());
  const [shareForm, setShareForm] = useState({ slug: "", title: "", password: "" });
  const [shareResult, setShareResult] = useState("");
  const [sharesOpen, setSharesOpen] = useState(false);
  const [shares, setShares] = useState([]);

  async function loadData() {
    const [channelsResponse, epgResponse, stateResponse] = await Promise.all([
      api("/api/channels"),
      api(`/api/epg?start=${fromLocalInput(rangeStart)}&end=${fromLocalInput(rangeEnd)}`),
      api("/api/state"),
    ]);
    if (!channelsResponse.ok) return;
    const channelsPayload = await channelsResponse.json();
    const epgPayload = await epgResponse.json();
    const statePayload = await stateResponse.json();
    setChannels(channelsPayload.channels);
    setPrograms(epgPayload.programs);
    setStatus(`${statePayload.channels} channels, ${statePayload.programs} guide items`);
  }

  useEffect(() => {
    loadData();
  }, [rangeStart, rangeEnd]);

  const groups = useMemo(() => Array.from(new Set(channels.map((channel) => channel.group_name || "Other"))).sort(), [channels]);

  const visibleChannels = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matchingProgramChannels = new Set(
      programs
        .filter((program) => `${program.title} ${program.description || ""}`.toLowerCase().includes(needle))
        .map((program) => program.channel_id),
    );
    return channels.filter((channel) => {
      if (group && channel.group_name !== group) return false;
      if (!needle) return true;
      return channel.name.toLowerCase().includes(needle) || matchingProgramChannels.has(channel.id);
    });
  }, [channels, group, programs, search]);

  function toggleProgram(program) {
    setSelectedProgramIds((current) => {
      const selectedPrograms = Array.from(current).map((id) => programs.find((item) => item.id === id)).filter(Boolean);
      const next = selectedPrograms.some((item) => item.channel_id !== program.channel_id) ? new Set() : new Set(current);
      if (next.has(program.id)) next.delete(program.id);
      else next.add(program.id);
      return next;
    });
    setSelectedChannelId(program.channel_id);
  }

  async function refresh() {
    setStatus("Refreshing sources...");
    await api("/api/refresh", { method: "POST" });
    await loadData();
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    navigate("/login");
  }

  async function createShare() {
    const response = await api("/api/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...shareForm,
        programIds: Array.from(selectedProgramIds),
        channelId: selectedChannelId,
        startsAt: fromLocalInput(rangeStart),
        endsAt: fromLocalInput(rangeEnd),
        mode: selectedProgramIds.size ? "programs" : "range",
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setShareResult(payload.error || "Could not create share.");
      return;
    }
    const url = payload.url.startsWith("/") ? `${window.location.origin}${payload.url}` : payload.url;
    setShareResult(url);
    if (sharesOpen) loadShares();
  }

  async function loadShares() {
    const response = await api("/api/shares");
    if (!response.ok) return;
    const payload = await response.json();
    setShares(payload.shares);
  }

  async function deleteShare(id) {
    await api(`/api/shares/${id}`, { method: "DELETE" });
    await loadShares();
  }

  function shiftWindow(hours) {
    const delta = hours * 60 * 60 * 1000;
    setRangeStart(toLocalInput(new Date(new Date(rangeStart).getTime() + delta)));
    setRangeEnd(toLocalInput(new Date(new Date(rangeEnd).getTime() + delta)));
  }

  function jumpToNow() {
    const duration = new Date(rangeEnd).getTime() - new Date(rangeStart).getTime();
    const start = new Date(Date.now() - 30 * 60 * 1000);
    setRangeStart(toLocalInput(start));
    setRangeEnd(toLocalInput(new Date(start.getTime() + duration)));
  }

  function setWindowHours(hours) {
    const start = new Date(rangeStart);
    setRangeEnd(toLocalInput(new Date(start.getTime() + hours * 60 * 60 * 1000)));
  }

  const selectedPrograms = Array.from(selectedProgramIds)
    .map((id) => programs.find((program) => program.id === id))
    .filter(Boolean)
    .sort((a, b) => a.start_at - b.start_at);

  const selectedSummary = selectedPrograms.length
    ? `${selectedPrograms.length} selected: ${formatDateTime.format(new Date(selectedPrograms[0].start_at * 1000))} - ${formatDateTime.format(new Date(selectedPrograms.at(-1).end_at * 1000))}`
    : selectedChannelId
      ? `${channels.find((channel) => channel.id === selectedChannelId)?.name || "Channel"}: ${formatDateTime.format(new Date(rangeStart))} - ${formatDateTime.format(new Date(rangeEnd))}`
      : "Select one or more shows, or choose a channel and time window.";

  return (
    <main className="appShell">
      <header className="topbar">
        <div>
          <h1>IPTV Share</h1>
          <p>{status}</p>
        </div>
        <div className="toolbar">
          <button type="button" onClick={() => {
            const next = !sharesOpen;
            setSharesOpen(next);
            if (next) loadShares();
          }}>Shares</button>
          <button type="button" onClick={refresh}>Refresh</button>
          <button type="button" onClick={logout}>Log out</button>
        </div>
      </header>

      <section className="controls">
        <label>
          Search
          <input value={search} onChange={(event) => setSearch(event.target.value)} type="search" placeholder="Channel or show" />
        </label>
        <label>
          Group
          <select value={group} onChange={(event) => setGroup(event.target.value)}>
            <option value="">All groups</option>
            {groups.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label>
          Start
          <input value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} type="datetime-local" />
        </label>
        <label>
          End
          <input value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} type="datetime-local" />
        </label>
        <div className="timeControls">
          <button type="button" onClick={() => shiftWindow(-6)}>Back 6h</button>
          <button type="button" onClick={jumpToNow}>Now</button>
          <button type="button" onClick={() => shiftWindow(6)}>Next 6h</button>
          <button type="button" onClick={() => setWindowHours(24)}>24h</button>
          <button type="button" onClick={() => setWindowHours(48)}>48h</button>
        </div>
      </section>

      {sharesOpen && <ShareAdmin shares={shares} onRefresh={loadShares} onDelete={deleteShare} />}

      <GuideGrid
        channels={visibleChannels}
        programs={programs}
        start={fromLocalInput(rangeStart)}
        end={fromLocalInput(rangeEnd)}
        selectedChannelId={selectedChannelId}
        selectedProgramIds={selectedProgramIds}
        onChannelSelect={(channelId) => {
          setSelectedChannelId(channelId);
          setSelectedProgramIds(new Set());
        }}
        onProgramToggle={toggleProgram}
      />

      <aside className="selectionPanel">
        <div>
          <h2>Create Share</h2>
          <p>{selectedSummary}</p>
        </div>
        <div className="panelFields">
          <label>
            Link name
            <input value={shareForm.slug} onChange={(event) => setShareForm({ ...shareForm, slug: event.target.value })} placeholder="optional-name" />
          </label>
          <label>
            Title
            <input value={shareForm.title} onChange={(event) => setShareForm({ ...shareForm, title: event.target.value })} placeholder="Optional display title" />
          </label>
          <label>
            Share password
            <input value={shareForm.password} onChange={(event) => setShareForm({ ...shareForm, password: event.target.value })} type="password" placeholder="Optional" />
          </label>
        </div>
        <div className="toolbar">
          <button type="button" onClick={() => {
            setSelectedProgramIds(new Set());
            setSelectedChannelId(null);
            setShareResult("");
          }}>Clear</button>
          <button type="button" className="primary" onClick={createShare}>Create Link</button>
        </div>
        <p className="shareResult">{shareResult && (shareResult.startsWith("http") ? <a href={shareResult} target="_blank" rel="noreferrer">{shareResult}</a> : shareResult)}</p>
      </aside>
    </main>
  );
}

function ShareAdmin({ shares, onRefresh, onDelete }) {
  return (
    <section className="shareAdmin">
      <div className="shareAdminHeader">
        <h2>Share Links</h2>
        <button type="button" onClick={onRefresh}>Reload</button>
      </div>
      <div className="shareTable">
        {shares.length === 0 && <p className="emptyState">No share links yet.</p>}
        {shares.map((share) => {
          const url = share.url.startsWith("/") ? `${window.location.origin}${share.url}` : share.url;
          return (
            <article key={share.id} className="shareRow">
              <div>
                <strong>{share.title || share.slug}</strong>
                <span>{share.channel_name} · {formatDateTime.format(new Date(share.starts_at * 1000))} - {formatDateTime.format(new Date(share.ends_at * 1000))}</span>
                <a href={url} target="_blank" rel="noreferrer">{url}</a>
              </div>
              <div className="shareMeta">
                <span>{share.opened_count} opens</span>
                <span>{share.has_password ? "Password" : "Public"}</span>
                <span>{share.last_opened_at ? `Last ${formatDateTime.format(new Date(share.last_opened_at * 1000))}` : "Never opened"}</span>
              </div>
              <button type="button" className="danger" onClick={() => onDelete(share.id)}>Delete</button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function GuideGrid({ channels, programs, start, end, selectedChannelId, selectedProgramIds, onChannelSelect, onProgramToggle }) {
  const span = Math.max(1, end - start);
  const hours = Math.max(1, span / 3600);
  const timelineWidth = Math.max(1440, Math.ceil(hours * 220));
  const currentTs = Math.floor(Date.now() / 1000);
  const nowPercent = currentTs >= start && currentTs <= end ? ((currentTs - start) / span) * 100 : null;
  const marks = [];
  for (let ts = Math.ceil(start / 3600) * 3600; ts <= end; ts += 3600) marks.push(ts);

  return (
    <section className="workspace">
      <div className="guideScroller">
        <div className="guideHeader" style={{ width: `${240 + timelineWidth}px` }}>
          <div className="channelHeader">Channels</div>
          <div className="timeAxis" style={{ width: `${timelineWidth}px` }}>
          {marks.map((mark) => (
            <span key={mark} style={{ left: `${((mark - start) / span) * 100}%` }}>{formatTime.format(new Date(mark * 1000))}</span>
          ))}
          {nowPercent !== null && <i className="nowMarker axisMarker" style={{ left: `${nowPercent}%` }} />}
          </div>
        </div>
        <div className="guideGrid" style={{ width: `${240 + timelineWidth}px` }}>
          {channels.map((channel) => (
            <div key={channel.id} className="guideRow">
              <button className={`channelCell ${selectedChannelId === channel.id ? "active" : ""}`} type="button" onClick={() => onChannelSelect(channel.id)}>
                {channel.logo ? <img src={channel.logo} alt="" /> : <span className="logoFallback">{channel.name.slice(0, 2)}</span>}
                <span>{channel.name}</span>
              </button>
              <div className="programLane" style={{ width: `${timelineWidth}px` }}>
                {nowPercent !== null && <i className="nowMarker" style={{ left: `${nowPercent}%` }} />}
                {programs.filter((program) => program.channel_id === channel.id).map((program) => {
                  const left = Math.max(0, ((program.start_at - start) / span) * 100);
                  const width = Math.max(3, ((Math.min(program.end_at, end) - Math.max(program.start_at, start)) / span) * 100);
                  return (
                    <button
                      key={program.id}
                      type="button"
                      className={`event ${selectedProgramIds.has(program.id) ? "selected" : ""}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      onClick={() => onProgramToggle(program)}
                    >
                      <strong>{program.title}</strong>
                      <span>{formatTime.format(new Date(program.start_at * 1000))}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SharePage({ slug }) {
  const [share, setShare] = useState(null);
  const [message, setMessage] = useState("");

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

  const starts = new Date(share.starts_at * 1000);
  const ends = new Date(share.ends_at * 1000);
  const state = share.server_now < share.starts_at ? "Starts" : share.server_now <= share.ends_at ? "Live now" : "Ended";

  return (
    <main className="shareShell">
      <section className="shareHero">
        <div>
          <h1>{share.title || "Shared IPTV Window"}</h1>
          <p>{share.channel_name}</p>
        </div>
        <time>{state}: {formatDateTime.format(starts)} - {formatDateTime.format(ends)}</time>
      </section>
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
      {!share.locked && share.stream_url && <Player src={share.stream_url} kind={share.stream_kind} />}
      {!share.locked && !share.stream_url && <p className="notLive">This share is not currently in its stream window.</p>}
      <section className="programList">
        {share.programs.map((program) => (
          <article key={program.id} className="programRow">
            <strong>{program.title}</strong>
            <span>{formatDateTime.format(new Date(program.start_at * 1000))} - {formatDateTime.format(new Date(program.end_at * 1000))}</span>
            <p>{program.description}</p>
          </article>
        ))}
      </section>
    </main>
  );
}

function Player({ src, kind }) {
  const videoRef = React.useRef(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.muted = false;
    video.defaultMuted = false;
    video.volume = 1;
    video.removeAttribute("muted");
    setMessage("");

    const clearRecoveredError = () => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused) setMessage("");
    };
    video.addEventListener("playing", clearRecoveredError);
    video.addEventListener("canplay", clearRecoveredError);

    let cleanup = () => {};
    if (kind === "hls" && Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: false,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        liveSyncDurationCount: 6,
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) setMessage(`HLS playback failed: ${data.details || data.type}`);
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      cleanup = () => {
        hls.destroy();
      };
    } else if (kind === "mpegts" && mpegts.getFeatureList().mseLivePlayback) {
      const player = mpegts.createPlayer(
        {
          type: "mse",
          isLive: true,
          url: src,
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
      cleanup = () => {
        player.unload();
        player.detachMediaElement();
        player.destroy();
      };
    } else {
      if (kind === "mpegts") setMessage("This browser does not support MPEG-TS playback through Media Source Extensions.");
      video.src = src;
    }

    return () => {
      video.removeEventListener("playing", clearRecoveredError);
      video.removeEventListener("canplay", clearRecoveredError);
      cleanup();
    };
  }, [src, kind]);

  return (
    <section className="playerArea">
      <video ref={videoRef} controls playsInline preload="auto" />
      {message && <p className="playerMessage">{message}</p>}
    </section>
  );
}

function Root() {
  const path = useLocationPath();
  if (path === "/login") return <Login />;
  if (path.startsWith("/s/")) return <SharePage slug={decodeURIComponent(path.split("/").pop())} />;
  return <AppGuide />;
}

createRoot(document.getElementById("root")).render(<Root />);
