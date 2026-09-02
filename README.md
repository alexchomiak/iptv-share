# IPTV Share

A Node + React single-container web app for browsing an IPTV XMLTV guide, selecting events or a time window, and creating public share links. Share links can optionally require a password before playback starts.

## MVP Features

- Docker-ready single container
- Node/Express backend
- React/Vite frontend
- SQLite persistence
- Admin login from environment variables
- M3U playlist import
- XMLTV EPG import
- Channel guide explorer
- 8-hour default guide window with 6-hour, 24-hour, and 48-hour paging
- Current-time marker in the guide
- Whole-guide EPG search with jump-to-event results
- Event detail panel with full title, description, and available EPG artwork
- Backend-proxied channel logos and EPG artwork for public-host access
- Event selection across one channel
- Manual date/time range sharing
- Named share links or generated UUID links
- Optional password per share link
- Permanent static schedule shares
- ESPN game search/linking for scheduled share events
- Share link admin panel with open counts, last-opened time, and delete controls
- Public share pages anyone can open
- Gated stream proxy with HLS playlist rewriting
- HLS.js playback for common `.m3u8` streams
- MPEG-TS playback through `mpegts.js` for browser-compatible H.264/AAC TS feeds
- Native video fallback for browser-supported files

## Local Test

Build and run:

```bash
docker compose up --build
```

Open:

```text
http://localhost:8080
```

Default login:

```text
Username: admin
Password: admin
```

The included sample data has a few demo channels and guide entries for September 1, 2026.

## Configuration

Set these in `docker-compose.yml` or your Unraid container template:

```env
APP_USERNAME=admin
APP_PASSWORD=change-me
SESSION_SECRET=change-this-long-random-value
DATABASE_PATH=/data/app.sqlite
M3U_URL=https://example.com/playlist.m3u
EPG_URL=https://example.com/guide.xml
PUBLIC_BASE_URL=https://your-public-host.example
EPG_REFRESH_SECONDS=21600
STREAM_GRACE_SECONDS=0
SHARE_AUTO_DELETE_SECONDS=300
TRANSCODE_MPEGTS=true
FFMPEG_HWACCEL=none
FFMPEG_VAAPI_DEVICE=/dev/dri/renderD128
ESPN_SEARCH_CACHE_SECONDS=21600
ESPN_LIVE_CACHE_SECONDS=60
ESPN_LIVE_CACHE_SECONDS_NFL=60
ESPN_LIVE_CACHE_SECONDS_MLB=150
ESPN_LIVE_CACHE_SECONDS_NBA=60
ESPN_LIVE_CACHE_SECONDS_NCAAFB=60
ESPN_LIVE_CACHE_SECONDS_NCAAMB=60
ESPN_MAX_REQUESTS_PER_DAY=2000
PORT=8080
```

Mount `/data` as persistent storage.

## Local Dev Without Docker

Install dependencies:

```bash
npm install
```

Run the backend and React dev server:

```bash
npm run dev
```

Open:

```text
http://localhost:5173
```

## Testing With Your Local M3U/EPG

If your M3U and EPG are already hosted somewhere on your home network, set `M3U_URL` and `EPG_URL` to those HTTP URLs.

For example, if they are available from another device/NAS:

```yaml
environment:
  M3U_URL: http://192.168.1.50:8081/playlist.m3u
  EPG_URL: http://192.168.1.50:8081/guide.xml
```

If the files are served from the same computer running Docker, use:

```yaml
environment:
  M3U_URL: http://host.docker.internal:8081/playlist.m3u
  EPG_URL: http://host.docker.internal:8081/guide.xml
```

Then run:

```bash
docker compose up --build
```

Open `http://localhost:8080`, log in, and click **Refresh** if the guide was already open before you changed URLs.

The guide starts on an 8-hour window. Use **Back 6h**, **Now**, **Next 6h**, **Show 12h**, **Next 24h**, and **Next 48h** to move farther through the schedule. A thin red line marks the current time whenever it falls inside the visible window.

## Creating A Share

1. Log in.
2. Select one or more guide events on the same channel.
3. Or select a channel and use the Start/End fields as a manual time range.
4. Optionally enter a link name, title, and password.
5. Click **Create Link**.

If a password is set, visitors can see the event info but must enter the password before the stream is loaded.

## Managing Shares

Click **Shares** in the top toolbar to view active share links. The panel shows each URL, whether it is public or password-protected, how many times it has been opened, the last-opened time, and a delete button for removing links you no longer want active.

Use **Create Static** in the Shares panel for a permanent schedule share such as `/s/da-bears`. Static shares do not auto-delete. Open **Schedule** on a static share, select an EPG event in the guide, optionally search/link an ESPN game, and then click **Add Selected EPG Event**.

ESPN linking uses public ESPN scoreboard data for NFL, NBA, college football, and men's college basketball. It searches future scoreboard ranges, so you can attach a game before the event airs.

ESPN calls are cached in SQLite. Scoreboard/search windows default to a 6-hour cache, live game summaries default to a 60-second cache, and the app has a local outbound ESPN ceiling of `ESPN_MAX_REQUESTS_PER_DAY` per UTC day. Search filtering happens locally against cached scoreboard windows, so repeated searches by viewers/admins do not create repeated ESPN calls.

Live ESPN refresh intervals are configurable by league. MLB defaults to 150 seconds; NFL, NBA, college football, and men's college basketball default to 60 seconds. Public pages only fetch live ESPN summaries while at least one viewer is actively streaming that share.

## Public Share Security

Public playback is share-record based. A public visitor gets `/s/{share-name}`, and playback goes through `/api/public/stream/{share-name}`. The app looks up that share in SQLite, checks the optional password unlock cookie, checks the share time window, and then proxies the stream.

The public endpoint does not expose a direct channel id route. HLS playlists are rewritten so segment URLs continue to pass through the same share-gated route. Rewritten segment URLs are signed with `SESSION_SECRET` to avoid turning the app into an open proxy.

Temporary share links are automatically deleted `SHARE_AUTO_DELETE_SECONDS` after their final selected event or manual time window ends. The default is 300 seconds. Active temporary streams are also cut off after that same deadline. Static schedule shares stay permanent, but each scheduled event only streams during its own event window plus the configured grace/delete buffer.

## Notes

Browser IPTV playback depends on the stream container and codecs. This MVP supports HLS via HLS.js, MPEG-TS via mpegts.js, native browser playback, and an FFmpeg-backed MPEG-TS normalization path. By default, MPEG-TS shares are served to viewers as fragmented MP4 with copied H.264 video and AAC audio, which fixes common AC-3/no-audio and mobile playback failures. Set `TRANSCODE_MPEGTS=false` to disable that path.

For iPhone/iPad Safari, MPEG-TS shares are exposed as a temporary HLS session. The server first tries to remux/copy Safari-compatible video codecs (`h264`/`hevc`) and only re-encodes video when the source codec requires it. On an Unraid box with Intel VAAPI available, set:

```env
FFMPEG_HWACCEL=vaapi
FFMPEG_VAAPI_DEVICE=/dev/dri/renderD128
```

Run the container with the GPU devices exposed:

```bash
docker run \
  --device /dev/dri/card0:/dev/dri/card0 \
  --device /dev/dri/renderD128:/dev/dri/renderD128 \
  --group-add="18" \
  ...
```

The VAAPI path uses `h264_vaapi` only when video re-encoding is unavoidable; normal H.264/HEVC streams still use low-CPU copy/remux.

For Docker Compose on Unraid/Linux, add the device mappings to the service:

```yaml
devices:
  - /dev/dri/card0:/dev/dri/card0
  - /dev/dri/renderD128:/dev/dri/renderD128
group_add:
  - "18"
```

Inside the running container, `vainfo --display drm --device /dev/dri/renderD128` should list supported VAAPI profiles, and `ffmpeg -hide_banner -encoders | grep vaapi` should include `h264_vaapi`.
