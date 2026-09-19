# ZoZoCloud

**An independent personal file library with a Telegram storage backend.** Upload documents, photos and videos — including iPhone
HEVC/H.265 recordings — store them through your connected Telegram account (2 GB per file, 4 GB with Premium), and stream them back
from any device with real seeking, thumbnails and one-click H.264 conversion.

ZoZoCloud is independently operated and is not affiliated with, sponsored by or endorsed by Telegram.

Full-stack **MERN** app: MongoDB (with a zero-config embedded fallback), Express, React 18 + Vite, Node.js, and
`teleproto` (MTProto) talking to Telegram as a storage backend.

```
┌────────────┐   chunked, resumable    ┌──────────────────────┐   MTProto    ┌───────────────────┐
│  React UI  │ ──────────────────────► │  Express + MongoDB   │ ───────────► │  Your Telegram    │
│  (Vite)    │ ◄────────────────────── │  ffmpeg · sharp      │ ◄─────────── │  Saved Messages / │
└────────────┘   SSE progress, ranges  └──────────────────────┘   streaming  │  private channel  │
                                                                             └───────────────────┘
```

---

## Features

**Storage**
- 📤 **Chunked, resumable uploads** (8 MB parts, 3 parallel chunks, 2 parallel files) — a dropped connection resumes
  instead of restarting.
- ☁️ **Telegram as the backend**: files become messages in *Saved Messages* (or any private channel/chat you pick),
  so they are replicated, private to your account and effectively unlimited.
- ☁️ **Telegram-only uploads** — if Telegram is disconnected, uploads pause instead of falling back to permanent
  server storage.
- 🗂 Folders, nested folder trees, drag & drop of whole folders (structure is recreated in the drive), rename, move,
  star, trash with 30-day auto-purge, permanent delete.
- 🔐 Session strings are **encrypted at rest**; JWT auth via httpOnly cookie + bearer token.

**Video & photos**
- 🎬 **HTTP range streaming** — scrub through hours-long videos instantly, no download.
- 📱 **iPhone HEVC handled properly**: the server probes every upload with ffprobe, flags H.265/HVC1 files, and offers
  a **one-click server-side transcode to H.264 MP4** (faststart, seekable). The original is kept; the player switches
  to the browser-friendly copy automatically when it is ready.
- 🎞️ **Container-aware playback**: MKV, MP4, MOV and WebM are evaluated separately from their video/audio codecs.
  MKV is attempted natively first on the current browser/device; if that fails, H.264-in-MKV can be remuxed to MP4
  without re-encoding while incompatible codecs use the conversion queue.
- 🖼 Thumbnails + 24px **LQIP blur-up placeholders** for photos *and* videos, HEIC → web preview renditions.
- ▶️ In-browser preview for video, audio, images, PDF, text/code and Office documents (download path).

**Sharing & access**
- 🔗 **Public share links** (`/s/:token`) with optional password and expiry; recipients stream without an account.
- 📊 Live upload dock with per-chunk progress, speed and ETA; background job list for transcodes.
- ⚡ **SSE** for real-time progress (`file:progress`, `file:ready`, `job:*`), so multiple tabs stay in sync.
- ⌨️ Keyboard shortcuts, grid/list views, dark/light theme, search, and a responsive mobile layout.

---

## Quick start

Requires **Node 18+** (Node 22 recommended). MongoDB is optional; a connected Telegram account is required to upload.

```bash
# 1. install both packages
npm --prefix server install
npm --prefix client install

# 2. configure the server
cp .env.example .env

# 3. build the UI and start everything on http://localhost:5000
npm --prefix client run build
npm --prefix server start
```

Open <http://localhost:5000>, create an account, connect Telegram in Settings, and drop a file anywhere in the window.

**Development mode** (hot reload, two terminals):

```bash
npm --prefix server run dev      # API on :5000
npm --prefix client run dev      # Vite on :5173, proxies /api → :5000
```

With no `MONGODB_URI`, the server uses an embedded database in `./data` — the app is still the same MERN code path,
and switching to MongoDB/Atlas later is a single environment variable.

---

## Connecting a Telegram storage backend

Uploads are accepted only after you explicitly connect **your Telegram account**:

1. Go to <https://my.telegram.org> → *API development tools* → create an application → copy **api_id** and **api_hash**.
2. In the app: **Settings → Connect Telegram** (or the sidebar prompt), enter `api_id`, `api_hash` and your phone
   number, then the login code Telegram sends (plus your 2FA password if enabled).
3. Choose the destination: **Saved Messages** (default, private) or any channel/chat from the picker.

That's it — every new upload goes to Telegram, and streaming, thumbnails and conversion keep working exactly the same.
You can also pre-fill the wizard for every user via `TG_API_ID` / `TG_API_HASH` in `.env`.

Resumable chunks are staged briefly under `UPLOAD_TMP_PATH` while an upload is in progress, then deleted after
Telegram confirms the file. They are never retained as the permanent storage copy.

> The login code and 2FA password are processed transiently by this server and are not stored. The resulting session
> string and API hash are encrypted with `SESSION_ENCRYPTION_KEY` (falls back to `JWT_SECRET`). Only use a deployment
> whose operator you trust, and revoke its session from Telegram's Devices settings if you stop using it.

---

## How HEVC iPhone videos work

| Step | What happens |
| --- | --- |
| Upload | The `.mov` is streamed in 8 MB chunks, assembled, then pushed to Telegram. |
| Probe | `ffprobe` records codec (`hevc`/`hvc1`), resolution, duration, fps, bitrate, rotation. |
| Classify | Container, video codec and audio codec are evaluated separately. MP4/MOV HEVC is conditional; MKV uses a native platform attempt. |
| UI | The real MKV stream opens directly first. Conversion is offered only after that browser/device reports a playback error. |
| Convert | A background job downloads the original, re-encodes to H.264/AAC MP4 with `+faststart`, stores it as a new file linked by `derivedFrom`, and streams progress over SSE. |
| Play | The player auto-switches to the H.264 copy and offers a chip to flip between *Original (HEVC)* and *H.264 copy*. |

If native MKV playback fails, H.264 video uses the faster remux path: ffmpeg copies the video stream into an MP4
container and only converts audio when required. HEVC-in-MKV can still use H.264 conversion for universal playback.

Browsers that *can* decode HEVC (Safari on macOS/iOS, Chrome with the HEVC extension) play the original directly —
the UI tries native playback first and falls back to the conversion prompt on error.

---

## Tests

Two suites, both hitting a running server:

```bash
npm --prefix server start            # terminal 1

node scripts/smoke-test.mjs          # terminal 2 — 95 backend checks
npm --prefix client run test:ui      #            — 26 UI checks (headless, jsdom)
```

- **`scripts/smoke-test.mjs`** — auth/JWT, capabilities, SSE, folder CRUD, chunked + resumable uploads, HEVC probing,
  thumbnails/ETag/304, range streaming (200/206/416/seek byte-match), library views/search/sort, transcode job,
  share links (public, password, revoke), trash/restore/delete, stats, account cleanup.
- **`scripts/ui-test.mjs`** — bundles the real client with esbuild and runs it inside jsdom against the live API:
  signup → empty state → upload through the real queue with live SSE progress → HEVC badges → Videos view convert
  callout → transcode + auto-switch playback → details panel → share link → public page → trash/restore → rename →
  new folder → search → settings → theme/view persistence → list sorting → sign out. Any React warning or console
  error fails the run.

---

## Configuration

Everything lives in `.env` (see [`.env.example`](.env.example) for the annotated list).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `5000` / `0.0.0.0` | HTTP listener |
| `JWT_SECRET` | dev placeholder | Token signing — **change in production** |
| `SESSION_ENCRYPTION_KEY` | `JWT_SECRET` | AES key for stored Telegram sessions |
| `MONGODB_URI` / `MONGODB_DB` | *(empty)* / `telegram_cloud` | Empty ⇒ embedded DB in `./data` |
| `TG_API_ID` / `TG_API_HASH` / `TG_PHONE` | *(empty)* | Pre-fills the connect wizard |
| `TG_CHAT_TARGET` | `me` | `me` = Saved Messages, or a channel/chat id |
| `TG_UPLOAD_WORKERS` / `TG_UPLOAD_PART_KB` | `3` / `512` | Telegram upload tuning |
| `FFMPEG_PATH` / `FFPROBE_PATH` | auto | Bundled npm binaries are detected automatically |
| `ENABLE_TRANSCODE` | `1` | Set `0` to disable HEVC → H.264 conversion |
| `TRANSCODE_PRESET` / `TRANSCODE_CRF` | `superfast` / `24` | H.264 speed and quality trade-off |
| `TRANSCODE_MAX_DIMENSION` | `1920` | Downscale browser copies to at most 1080p |
| `MAX_CONCURRENT_TRANSCODES` | `1` | Avoid competing ffmpeg jobs on limited CPUs |
| `MAX_UPLOAD_SIZE` | `4294967296` | 4 GB cap (Telegram Premium) |
| `UPLOAD_CHUNK_SIZE` | `8388608` | Client chunk size |
| `TRASH_AUTO_PURGE_DAYS` | `30` | Trash retention |
| `ALLOW_SIGNUP` | `true` | Set `false` to close registrations |

ffmpeg/ffprobe/sharp/heic are installed from npm, so **no system packages are required**.

---

## Project layout

```
server/                     Express API (ESM)
  src/index.js              boot: helmet, CORS, compression, routes, SPA fallback, job recovery
  src/config.js             every environment variable, validated + defaulted
  src/routes/               auth · uploads · files · folders · shares · public · telegram · jobs · events(SSE) · meta
  src/services/             uploadManager · files · folders · media(ffmpeg/sharp) · streaming(range) · shares · jobs · importer
  src/storage/              Telegram provider + session vault + read/delete compatibility for legacy local objects
  src/db/                   MongoDB driver + embedded (NeDB) driver behind one interface
  src/lib/                  errors · events(bus) · crypto · fileTypes · concurrency · logger

client/                     React 18 + Vite
  src/App.jsx               router, auth guard, bootstrap
  src/components/           AppShell · Sidebar · TopBar · FileGrid · FileList · FileMenu · PreviewModal · VideoStage
                            UploadDock · DropZone · SelectionBar · Breadcrumbs · dialogs · ErrorBoundary · common
  src/pages/                Login · Drive (all library views) · Shares · Shared(public) · Settings · NotFound
  src/store/                zustand: auth · drive · uploads · jobs · ui
  src/hooks/                useEvents(SSE) · useDriveView · useFileActions · useHotkeys
  src/lib/                  api(axios) · uploadQueue(chunked, resumable) · dropFiles(folder walk) · format
  src/styles/               design tokens + base + components + layout + responsive

scripts/smoke-test.mjs      95 backend checks
scripts/ui-test.mjs         26 headless UI checks
```

---

## API overview

| Area | Endpoints |
| --- | --- |
| Auth | `POST /api/auth/signup` · `login` · `logout` · `GET/PATCH/DELETE /api/auth/me` · `POST /api/auth/change-password` |
| Uploads | `POST /api/uploads` (session) · `PUT /api/uploads/:id/chunks/:i` · `GET /api/uploads/:id` (resume state) · `POST /api/uploads/:id/complete` · `cancel` · `POST /api/uploads/simple` |
| Files | `GET /api/files` (view/folder/q/sort/page) · `GET/PATCH /api/files/:id` · `GET /api/files/:id/stream` (range) · `download` · `thumbnail` · `preview` · `text` · `POST /api/files/:id/transcode` · `regenerate` · `retry` · `cancel` · `POST /api/files/move|star|trash|restore` · `DELETE /api/files` · `GET /api/files/stats` |
| Folders | `GET /api/folders` (tree) · `POST /api/folders` · `PATCH/DELETE /api/folders/:id` · `POST /api/folders/ensure-path` |
| Shares | `GET/POST /api/shares` · `PATCH/DELETE /api/shares/:token` · public: `GET /api/public/:token` (+`/stream`, `/download`, `/thumbnail`, `/preview`, `POST /unlock`) |
| Telegram | `GET /api/telegram/status` · `POST /api/telegram/login/start|code|password|resend|cancel` · `verify` · `disconnect` · `PATCH /api/telegram/chat-target` · `GET /api/telegram/chats|remote` · `POST /api/telegram/import` |
| Jobs / live | `GET /api/jobs` · `POST /api/jobs/:id/cancel` · `GET /api/events` (SSE) · `GET /api/meta/config|capabilities|summary` · `GET /healthz` |

Media URLs accept either the auth cookie or `?access_token=` so `<video>`, `<img>` and `EventSource` work without
custom headers.

---

## Production notes

- Set a strong `JWT_SECRET` (and ideally a separate `SESSION_ENCRYPTION_KEY`), `NODE_ENV=production`, and a real
  `MONGODB_URI`.
- Serve over HTTPS — the auth cookie is `secure` in production, and SSE needs a proxy that does not buffer
  (`proxy_buffering off` in nginx).
- `npm --prefix client run build` before starting; Express serves `client/dist` and falls back to `index.html` for
  client-side routes.
- Transcoding is CPU-bound: keep `ENABLE_TRANSCODE=1` on a machine with a couple of cores, or disable it and let
  users download HEVC originals.
- Restart-safe: interrupted uploads resume from their chunks, and queued/running jobs are recovered on boot.

## Notes & limits

- Telegram allows **2 GB per file** (4 GB with Premium); larger uploads are rejected with a clear error.
- MTProto user accounts are rate-limited by Telegram; the queue throttles concurrent uploads accordingly.
- HEIC stills are converted with `heic-convert` (WASM libheif) since sharp cannot decode them; if that fails the
  original is still stored and downloadable.
- This project stores files in *your own* Telegram account. Keep your API credentials and session private, and
  respect Telegram's Terms of Service.
