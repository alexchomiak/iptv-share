import { useEffect, useMemo, useRef, useState } from "react";
import { usernameColor } from "../../lib/userColors.js";

const usernameKey = "iptv-share-username";
const tokenPrefix = "iptv-share-viewer-token:";
const chatTimestampFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "2-digit",
  day: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function websocketUrl(slug) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/share/${encodeURIComponent(slug)}`;
}

function formatChatTimestamp(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) return "";
  return `${chatTimestampFormat.format(new Date(timestamp * 1000)).replace(",", "")} CST`;
}

function viewerLabel(viewer) {
  if (viewer.waiting) return "waiting";
  if (viewer.streaming) return "watching";
  if (viewer.kicked) return "removed";
  return viewer.online ? "online" : "offline";
}

function ViewerSection({ title, viewers, admin, defaultOpen = false, onKickViewer, onUnkickViewer }) {
  return (
    <details className="viewerSection" defaultOpen={defaultOpen}>
      <summary>{title} <span>{viewers.length}</span></summary>
      <div className="viewerPills">
        {viewers.length === 0 && <span className="emptyViewerLine">None</span>}
        {viewers.map((viewer) => (
          <div key={viewer.id} className={`viewerPillRow ${viewer.streaming ? "streaming" : viewer.waiting ? "waiting" : ""}`}>
            <span>
              <strong style={{ color: usernameColor(viewer.username) }}>{viewer.username}</strong> · {viewerLabel(viewer)}
            </span>
            {admin && viewer.kicked && <button type="button" onClick={() => onUnkickViewer?.(viewer.id)}>Restore</button>}
            {admin && !viewer.kicked && <button type="button" className="danger" onClick={() => onKickViewer?.(viewer.id)}>Kick</button>}
          </div>
        ))}
      </div>
    </details>
  );
}

function ShareChat({
  slug,
  locked,
  onViewerToken,
  onSlotStatus,
  onPresence,
  onSportsUpdate,
  streamActive,
  admin = false,
  onKickViewer,
  onUnkickViewer,
  sportsEventId,
}) {
  const [username, setUsername] = useState(() => localStorage.getItem(usernameKey) || "");
  const [draftName, setDraftName] = useState(() => localStorage.getItem(usernameKey) || "");
  const [messages, setMessages] = useState([]);
  const [viewers, setViewers] = useState([]);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("");
  const [showViewers, setShowViewers] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const socketRef = useRef(null);
  const messagesRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const tokenKey = useMemo(() => `${tokenPrefix}${slug}`, [slug]);

  useEffect(() => {
    if ((locked && !admin) || !username) return undefined;
    let closed = false;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const socket = new WebSocket(websocketUrl(slug));
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      const token = localStorage.getItem(tokenKey) || "";
      socket.send(JSON.stringify({ type: "hello", username, token, sportsEventId }));
      setStatus("");
    });
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === "hello") {
        localStorage.setItem(tokenKey, payload.token);
        onViewerToken?.(payload.token);
      }
      if (payload.type === "chatHistory") setMessages(payload.messages || []);
      if (payload.type === "chat") setMessages((current) => [...current.slice(-79), payload.message]);
      if (payload.type === "presence") {
        setViewers(payload.viewers || []);
        onPresence?.(payload.viewers || []);
      }
      if (payload.type === "sportsUpdate") onSportsUpdate?.(payload);
      if (payload.type === "kicked") {
        setStatus("You were removed from this stream.");
        onViewerToken?.("");
        onSlotStatus?.({ status: "kicked" });
      }
      if (payload.type === "streamSlot") onSlotStatus?.(payload);
      if (payload.type === "error") setStatus(payload.error || "Connection error.");
    });
    socket.addEventListener("close", () => {
      if (closed) return;
      const delay = Math.min(10000, 1000 + reconnectAttempt * 1500);
      setStatus(`Chat disconnected. Reconnecting in ${Math.ceil(delay / 1000)}s...`);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        setReconnectAttempt((current) => current + 1);
      }, delay);
    });

    return () => {
      closed = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      socket.close();
      socketRef.current = null;
    };
  }, [admin, locked, onPresence, onSlotStatus, onSportsUpdate, onViewerToken, reconnectAttempt, slug, sportsEventId, tokenKey, username]);

  useEffect(() => {
    if (!username || socketRef.current?.readyState !== WebSocket.OPEN) return;
    if (admin) return;
    socketRef.current.send(JSON.stringify({ type: "streamState", active: Boolean(streamActive), sportsEventId }));
  }, [admin, sportsEventId, streamActive, username]);

  useEffect(() => {
    if (!username || !admin || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: "streamState", active: Boolean(streamActive), sportsEventId }));
  }, [admin, sportsEventId, streamActive, username]);

  useEffect(() => {
    const element = messagesRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [messages]);

  function saveName(event) {
    event.preventDefault();
    const clean = draftName.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!clean) return;
    localStorage.setItem(usernameKey, clean);
    setUsername(clean);
  }

  function sendMessage(event) {
    event.preventDefault();
    const text = message.trim();
    if (!text || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: "chat", message: text }));
    setMessage("");
  }

  const onlineViewers = viewers.filter((viewer) => !viewer.kicked && viewer.online);
  const offlineViewers = viewers.filter((viewer) => !viewer.kicked && !viewer.online);
  const kickedViewers = viewers.filter((viewer) => viewer.kicked);

  return (
    <section className="shareChat">
      {(!locked || admin) && !username && (
        <div className="viewerNameOverlay">
          <form className="viewerNameModal" onSubmit={saveName}>
            <h2>Choose a chat name</h2>
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} autoFocus maxLength={40} placeholder="Your name" />
            <button type="submit" className="primary">Join</button>
          </form>
        </div>
      )}
      <div className="chatPanel">
        <div className="chatHeader">
          <div>
            <h2>Chat</h2>
            <p>{viewers.filter((viewer) => viewer.streaming).length} streaming · {viewers.length} in room</p>
          </div>
          <button type="button" className="iconButton" aria-label="Show viewers" onClick={() => setShowViewers((value) => !value)}>i</button>
          {showViewers && (
            <div className="viewerPopover">
              <strong>Viewers</strong>
              <ViewerSection title="Online Users" viewers={onlineViewers} admin={admin} defaultOpen onKickViewer={onKickViewer} onUnkickViewer={onUnkickViewer} />
              <ViewerSection title="Offline Users" viewers={offlineViewers} admin={admin} onKickViewer={onKickViewer} onUnkickViewer={onUnkickViewer} />
              <ViewerSection title="Kicked Users" viewers={kickedViewers} admin={admin} onKickViewer={onKickViewer} onUnkickViewer={onUnkickViewer} />
            </div>
          )}
        </div>
        <div className="chatMessages" ref={messagesRef}>
          {messages.length === 0 && <p>No messages yet.</p>}
          {messages.map((item) => (
            <div key={item.id} className="chatMessage">
              <div className="chatMessageMeta">
                <strong style={{ color: usernameColor(item.username) }}>{item.username}</strong>
                <time>{formatChatTimestamp(item.created_at)}</time>
              </div>
              <span>{item.message}</span>
            </div>
          ))}
        </div>
        <form className="chatComposer" onSubmit={sendMessage}>
          <input value={message} onChange={(event) => setMessage(event.target.value)} disabled={!username || (locked && !admin)} maxLength={500} placeholder="Message the room" />
          <button type="submit" disabled={!username || (locked && !admin)}>Send</button>
        </form>
        {status && <p className="chatStatus">{status}</p>}
      </div>
    </section>
  );
}

export default ShareChat;
