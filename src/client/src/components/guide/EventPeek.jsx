import { formatDateTime, formatTime } from "../../lib/time.js";

function EventPeek({ program, onClose }) {
  return (
    <section className="eventPeek">
      {(program.icon_url || program.icon) && <img src={program.icon_url || program.icon} alt="" />}
      <div>
        <strong>{program.title}</strong>
        <span>{program.channel_name} · {formatDateTime.format(new Date(program.start_at * 1000))} - {formatTime.format(new Date(program.end_at * 1000))}</span>
        {program.category && <small>{program.category}</small>}
        <p>{program.description || "No description in the EPG."}</p>
      </div>
      <button type="button" onClick={onClose}>Close</button>
    </section>
  );
}

export default EventPeek;
