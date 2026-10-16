import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatTime } from '../../lib/time.js';
import { GUIDE_ROW_HEIGHT, GUIDE_HEADER_HEIGHT, GUIDE_HOUR_WIDTH, GUIDE_CANVAS_HOURS, guideCanvasPosition, guideViewport } from '../../lib/guideWindow.js';

const timelineWidth = GUIDE_CANVAS_HOURS * GUIDE_HOUR_WIDTH;
const initial = () => guideCanvasPosition(Date.now() / 1000 - 1800);
const dayLabel = new Intl.DateTimeFormat([], { weekday: 'short', month: 'short', day: 'numeric' });

export default function GuideGrid({ channels, programs, selectedChannelId, selectedProgramIds, onChannelSelect, onProgramToggle, onProgramInspect, onViewportChange, jumpRequest, loading, error, onRetry }) {
  const scroller = useRef(null);
  const frame = useRef(null);
  const [position, setPosition] = useState(initial);
  const startRef = useRef(position.start);
  const [view, setView] = useState({ left: position.left, top: 0, width: 1200, height: 700, channelWidth: 255 });
  const [currentTs, setCurrentTs] = useState(() => Date.now() / 1000);
  const range = guideViewport({ ...view, start: position.start, count: channels.length });

  const readViewport = () => {
    const element = scroller.current;
    if (!element) return;
    let left = element.scrollLeft;
    if (left < timelineWidth * .2 || left > timelineWidth * .8) {
      const next = guideCanvasPosition(startRef.current + left * 3600 / GUIDE_HOUR_WIDTH);
      startRef.current = next.start;
      setPosition(next);
      element.scrollLeft = next.left;
      left = next.left;
    }
    setView({ left, top: element.scrollTop, width: element.clientWidth, height: element.clientHeight,
      channelWidth: parseFloat(getComputedStyle(element).getPropertyValue('--guide-channel-width')) || 255 });
  };
  useLayoutEffect(() => {
    scroller.current.scrollLeft = position.left;
    const observer = new ResizeObserver(readViewport);
    observer.observe(scroller.current);
    readViewport();
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current); };
  }, []);
  useLayoutEffect(() => {
    if (!jumpRequest) return;
    const next = guideCanvasPosition(jumpRequest.time - 1800);
    startRef.current = next.start;
    setPosition(next);
    scroller.current.scrollLeft = next.left;
    const index = channels.findIndex(channel => channel.id === jumpRequest.channelId);
    if (index >= 0) scroller.current.scrollTop = index * GUIDE_ROW_HEIGHT;
    readViewport();
  }, [jumpRequest]);
  useLayoutEffect(() => { readViewport(); }, [channels]);
  useEffect(() => {
    onViewportChange({ start: range.start, end: range.end, channelIds: channels.slice(range.first, range.last).map(channel => channel.id) });
  }, [range.start, range.end, range.first, range.last, channels, onViewportChange]);
  useEffect(() => {
    const timer = setInterval(() => setCurrentTs(Date.now() / 1000), 30000);
    return () => clearInterval(timer);
  }, []);

  const byChannel = useMemo(() => {
    const map = new Map();
    for (const program of programs) {
      if (program.start_at >= range.end + 3600 || program.end_at <= range.start - 3600) continue;
      if (!map.has(program.channel_id)) map.set(program.channel_id, []);
      map.get(program.channel_id).push(program);
    }
    return map;
  }, [programs, range.start, range.end]);
  const marks = [];
  for (let time = Math.floor(range.start / 3600) * 3600; time <= range.end + 3600; time += 3600) marks.push(time);
  const x = time => (time - position.start) * GUIDE_HOUR_WIDTH / 3600;
  const nowLeft = x(currentTs);
  return <section className="workspace virtualGuide" aria-label="Programme guide" aria-busy={loading}>
    <div className="guideScroller" ref={scroller} tabIndex={0} aria-label="Scroll channels vertically and programme times horizontally"
      onScroll={() => { if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = null; readViewport(); }); }}>
      <div className="guideHeader" style={{ width: view.channelWidth + timelineWidth, height: GUIDE_HEADER_HEIGHT }}>
        <div className="channelHeader"><span>Channels<small>{dayLabel.format(new Date(range.start * 1000))}</small></span>
          <button type="button" aria-label="Jump to current time" title="Jump to current time" onClick={() => {
            const next = guideCanvasPosition(Date.now() / 1000 - 1800);
            startRef.current = next.start; setPosition(next); scroller.current.scrollLeft = next.left; readViewport();
          }}>↶ Now</button>
        </div>
        <div className="timeAxis" style={{ width: timelineWidth }}>
          {marks.map(time => <span key={time} style={{ left: x(time) }}>{new Date(time * 1000).getHours() === 0 ? `${dayLabel.format(new Date(time * 1000))} · ` : ''}{formatTime.format(new Date(time * 1000))}</span>)}
          {nowLeft >= 0 && nowLeft <= timelineWidth && <i className="nowMarker axisMarker" style={{ left: nowLeft }} />}
        </div>
      </div>
      <div className="guideGrid" style={{ position: 'relative', width: view.channelWidth + timelineWidth, height: channels.length * GUIDE_ROW_HEIGHT + 110 }}>
        {channels.slice(range.first, range.last).map((channel, offset) => <div key={channel.id} className="guideRow" data-channel-id={channel.id}
          style={{ position: 'absolute', top: (range.first + offset) * GUIDE_ROW_HEIGHT, width: '100%' }}>
          <button className={`channelCell ${selectedChannelId === channel.id ? 'active' : ''}`} type="button" onClick={() => onChannelSelect(channel.id)} aria-pressed={selectedChannelId === channel.id}>
            {channel.logo ? <img src={channel.logo} alt="" loading="lazy" /> : <span className="logoFallback">{channel.name.slice(0, 2)}</span>}
            <span className="channelLabel">{channel.channel_number && <small>{channel.channel_number}</small>}<span>{channel.name}</span></span>
          </button>
          <div className="programLane" style={{ width: timelineWidth }}>
            {nowLeft >= 0 && nowLeft <= timelineWidth && <i className="nowMarker" style={{ left: nowLeft }} />}
            {(byChannel.get(channel.id) || []).map(program => <button key={program.id} type="button" className={`event ${selectedProgramIds.has(program.id) ? 'selected' : ''}`}
              aria-pressed={selectedProgramIds.has(program.id)} title={`${program.title} · ${formatTime.format(new Date(program.start_at * 1000))}`}
              style={{ left: x(program.start_at), width: Math.max(2, (program.end_at - program.start_at) * GUIDE_HOUR_WIDTH / 3600) }}
              onClick={() => { onProgramToggle(program); onProgramInspect(program); }}>
              <strong>{program.title}</strong><span>{formatTime.format(new Date(program.start_at * 1000))}</span>
            </button>)}
          </div>
        </div>)}
      </div>
    </div>
    {!channels.length && <p className="guideEmpty">No matching channels or programmes.</p>}
    {loading && <span className="guideLoadStatus" role="status">Loading guide…</span>}
    {error && <div className="guideLoadStatus" role="alert">{error} <button type="button" onClick={onRetry}>Retry</button></div>}
  </section>;
}
