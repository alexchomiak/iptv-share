import React, { useEffect, useState } from "react";
import Hls from "hls.js";
import mpegts from "mpegts.js";

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

function startAfterAttach(video, setMessage) {
  requestAnimationFrame(() => {
    const playPromise = video.play();
    if (!playPromise?.catch) return;
    playPromise.catch((error) => {
      if (error?.name === "AbortError") return;
      if (error?.name === "NotAllowedError") {
        setMessage("Press play to start the stream.");
        return;
      }
      setMessage(`Could not start playback: ${error?.message || error?.name || "unknown error"}`);
    });
  });
}

function withViewerToken(source, viewerToken) {
  if (!source || !viewerToken) return source;
  const url = new URL(source, window.location.origin);
  url.searchParams.set("viewer", viewerToken);
  return `${url.pathname}${url.search}${url.hash}`;
}

function Player({ src, hlsSrc, kind, viewerToken, onPlaybackActive }) {
  const videoRef = React.useRef(null);
  const [message, setMessage] = useState("");
  const [armed, setArmed] = useState(false);
  const armPlayback = () => setArmed(true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    setMessage("");
    video.removeAttribute("src");
    video.load();
    if (!armed) {
      return () => {
        onPlaybackActive?.(false);
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
    }
    const nativeHlsSupported = Boolean(video.canPlayType("application/vnd.apple.mpegurl"));
    const appleTouchDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    const clearRecoveredError = () => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused) setMessage("");
    };
    const reportNativeError = () => setMessage(describeVideoError(video, kind === "mpegts" && hlsSrc ? "HLS remux" : "Native video"));
    const reportActive = () => onPlaybackActive?.(true);
    const reportInactive = () => onPlaybackActive?.(false);
    video.addEventListener("playing", clearRecoveredError);
    video.addEventListener("playing", reportActive);
    video.addEventListener("pause", reportInactive);
    video.addEventListener("ended", reportInactive);
    video.addEventListener("canplay", clearRecoveredError);
    video.addEventListener("error", reportNativeError);

    let cleanup = () => {};
    const streamSrc = withViewerToken(src, viewerToken);
    const streamHlsSrc = withViewerToken(hlsSrc, viewerToken);

    if (kind === "hls" && nativeHlsSupported) {
      cleanup = attachNativeVideo(video, streamSrc);
    } else if (kind === "hls" && Hls.isSupported()) {
      cleanup = attachHlsJs(video, streamSrc, setMessage);
    } else if (kind === "mpegts" && streamHlsSrc && nativeHlsSupported && appleTouchDevice) {
      cleanup = attachNativeVideo(video, streamHlsSrc);
    } else if (kind === "mpegts" && mpegts.getFeatureList().mseLivePlayback) {
      cleanup = attachMpegTs(video, streamSrc, setMessage);
    } else if (kind === "mpegts" && streamHlsSrc && nativeHlsSupported) {
      cleanup = attachNativeVideo(video, streamHlsSrc);
    } else if (kind === "mpegts" && streamHlsSrc && Hls.isSupported()) {
      cleanup = attachHlsJs(video, streamHlsSrc, setMessage);
    } else {
      if (kind === "mpegts") setMessage("This browser does not support MPEG-TS playback through Media Source Extensions, and no HLS remux URL is available.");
      cleanup = attachNativeVideo(video, streamSrc);
    }
    startAfterAttach(video, setMessage);

    return () => {
      video.removeEventListener("playing", clearRecoveredError);
      video.removeEventListener("playing", reportActive);
      video.removeEventListener("pause", reportInactive);
      video.removeEventListener("ended", reportInactive);
      video.removeEventListener("canplay", clearRecoveredError);
      video.removeEventListener("error", reportNativeError);
      onPlaybackActive?.(false);
      cleanup();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src, hlsSrc, kind, viewerToken, onPlaybackActive, armed]);

  return (
    <section className="playerArea">
      <video
        ref={videoRef}
        controls
        playsInline
        preload="none"
        onPlay={armPlayback}
        onPointerDown={armPlayback}
        onTouchStart={armPlayback}
        onKeyDown={(event) => {
          if (event.key === " " || event.key === "Enter") armPlayback();
        }}
      />
      {!armed && (
        <button type="button" className="playerStartOverlay" onClick={armPlayback} aria-label="Play stream">
          <span className="playerStartButton" aria-hidden="true">
            <span />
          </span>
        </button>
      )}
      {message && <p className="playerMessage">{message}</p>}
    </section>
  );
}

export default Player;
