import { formatTime } from "../../lib/time.js";

function GuideGrid({ channels, programs, start, end, selectedChannelId, selectedProgramIds, onChannelSelect, onProgramToggle, onProgramInspect }) {
  const span = Math.max(1, end - start);
  const hours = Math.max(1, span / 3600);
  const channelWidth = 255;
  const timelineWidth = Math.max(1600, Math.ceil(hours * 280));
  const currentTs = Math.floor(Date.now() / 1000);
  const nowPercent = currentTs >= start && currentTs <= end ? ((currentTs - start) / span) * 100 : null;
  const marks = [];
  for (let ts = Math.ceil(start / 3600) * 3600; ts <= end; ts += 3600) marks.push(ts);

  return (
    <section className="workspace">
      <div className="guideScroller">
        <div className="guideHeader" style={{ width: `${channelWidth + timelineWidth}px` }}>
          <div className="channelHeader">Channels</div>
          <div className="timeAxis" style={{ width: `${timelineWidth}px` }}>
          {marks.map((mark) => (
            <span key={mark} style={{ left: `${((mark - start) / span) * 100}%` }}>{formatTime.format(new Date(mark * 1000))}</span>
          ))}
          {nowPercent !== null && <i className="nowMarker axisMarker" style={{ left: `${nowPercent}%` }} />}
          </div>
        </div>
        <div className="guideGrid" style={{ width: `${channelWidth + timelineWidth}px` }}>
          {channels.map((channel) => (
            <div key={channel.id} className="guideRow">
              <button className={`channelCell ${selectedChannelId === channel.id ? "active" : ""}`} type="button" onClick={() => onChannelSelect(channel.id)}>
                {channel.logo ? <img src={channel.logo} alt="" /> : <span className="logoFallback">{channel.name.slice(0, 2)}</span>}
                <span className="channelLabel">
                  {channel.channel_number ? <small>{channel.channel_number}</small> : null}
                  <span>{channel.name}</span>
                </span>
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
                      onMouseEnter={() => onProgramInspect(program)}
                      onFocus={() => onProgramInspect(program)}
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

export default GuideGrid;
