import { eventStart, formatDateTime } from "../../lib/time.js";

function StaticCountdown({ nextEvent, liveEvent, seconds, label }) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const heroEvent = nextEvent || liveEvent;
  const media = heroEvent?.icon_url || heroEvent?.icon;

  return (
    <section className={`staticCountdown ${media ? "hasMedia" : ""}`}>
      {media && <img src={media} alt="" />}
      <div className="countdownContent">
        <span>{label || (nextEvent ? "Next Up" : liveEvent ? "Live Now" : "Schedule")}</span>
        <h2>{heroEvent?.title || "No events scheduled"}</h2>
        {nextEvent && (
          <>
            <div className="countdownDigits" aria-label={`Starts in ${seconds} seconds`}>
              <CountdownUnit label="Days" value={days} />
              <CountdownUnit label="Hours" value={hours} />
              <CountdownUnit label="Minutes" value={minutes} />
              <CountdownUnit label="Seconds" value={remainingSeconds} />
            </div>
            <p>{formatDateTime.format(new Date(eventStart(nextEvent) * 1000))}</p>
          </>
        )}
        {liveEvent && !nextEvent && <p className="liveNowText">The scheduled stream is live.</p>}
        {!heroEvent && <p>Add events to this static share from the admin panel.</p>}
      </div>
    </section>
  );
}

function CountdownUnit({ label, value }) {
  const display = String(value).padStart(2, "0");
  return (
    <div className="countdownUnit">
      <strong key={display}>{display}</strong>
      <span>{label}</span>
    </div>
  );
}

export default StaticCountdown;
