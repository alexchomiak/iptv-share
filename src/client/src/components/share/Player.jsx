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

function Player({ src, hlsSrc, kind }) {
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
    video.removeAttribute("src");
    video.load();
    const nativeHlsSupported = Boolean(video.canPlayType("application/vnd.apple.mpegurl"));
    const appleTouchDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    const clearRecoveredError = () => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused) setMessage("");
    };
    const reportNativeError = () => setMessage(describeVideoError(video, kind === "mpegts" && hlsSrc ? "HLS remux" : "Native video"));
    video.addEventListener("playing", clearRecoveredError);
    video.addEventListener("canplay", clearRecoveredError);
    video.addEventListener("error", reportNativeError);

    let cleanup = () => {};
    if (kind === "hls" && nativeHlsSupported) {
      cleanup = attachNativeVideo(video, src);
    } else if (kind === "hls" && Hls.isSupported()) {
      cleanup = attachHlsJs(video, src, setMessage);
    } else if (kind === "mpegts" && hlsSrc && nativeHlsSupported && appleTouchDevice) {
      cleanup = attachNativeVideo(video, hlsSrc);
    } else if (kind === "mpegts" && mpegts.getFeatureList().mseLivePlayback) {
      cleanup = attachMpegTs(video, src, setMessage);
    } else if (kind === "mpegts" && hlsSrc && nativeHlsSupported) {
      cleanup = attachNativeVideo(video, hlsSrc);
    } else if (kind === "mpegts" && hlsSrc && Hls.isSupported()) {
      cleanup = attachHlsJs(video, hlsSrc, setMessage);
    } else {
      if (kind === "mpegts") setMessage("This browser does not support MPEG-TS playback through Media Source Extensions, and no HLS remux URL is available.");
      cleanup = attachNativeVideo(video, src);
    }

    return () => {
      video.removeEventListener("playing", clearRecoveredError);
      video.removeEventListener("canplay", clearRecoveredError);
      video.removeEventListener("error", reportNativeError);
      cleanup();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src, hlsSrc, kind]);

  return (
    <section className="playerArea">
      <video ref={videoRef} controls playsInline preload="auto" />
      {message && <p className="playerMessage">{message}</p>}
    </section>
  );
}

export default Player;
