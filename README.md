# Air: Active Interaction Rooms

Air (Active Interaction Rooms) is a video calling web app for large groups: up to 50 people per room, with an architecture that scales past 100. Instead of a peer-to-peer mesh (where every participant uploads a copy of their stream to everyone else), Air uses an **SFU (Selective Forwarding Unit)**: each participant uploads **one** stream to a media server that forwards it to the rest of the room. Upload bandwidth stays constant no matter how many people join.

> Share a link and join instantly. Built for the whole room, not just a handful.

Air is the large-room sibling to [**Pact**](https://github.com/AbhijeetP21/Pact), a privacy-first peer-to-peer app for ≤5 people. Air reuses Pact's shell (auth, rooms, design system, and on-device media processing) and swaps the mesh engine for a LiveKit SFU. That trade buys scale at the cost of pure P2P privacy: **media is relayed through (and decrypted at) the SFU.** The UI is honest about that.

## Principles

- **SFU, not mesh.** One upstream per participant; the server fans it out. Upload is O(1), not O(N).
- **Honest about the relay.** Media flows through the SFU, and Air says as much rather than implying end-to-end privacy.
- **Supabase for auth and room metadata only.** A server route mints short-lived LiveKit tokens after verifying auth and room membership.
- **On-device processing.** Noise suppression and background blur run in the browser; the *processed* tracks are what get published.

## Features

**Calling**
- Google OAuth and magic-link sign-in (Supabase)
- Create a room, share a link, join instantly
- Pre-join lobby with camera and mic preview, plus noise and blur toggles
- Adaptive, paginated participant grid with per-tile speaking indicators and connection status; spotlight any tile
- Selective subscription: video is pulled only for the participants on screen, so a 50-person room never streams 50 upstreams at once (audio stays subscribed for everyone)
- Mic, camera, screen share, camera flip (front/rear), and leave controls
- Live mic and camera state across the room, so you can see when someone mutes
- Session chat over LiveKit data channels that lives only for the call and disappears when it ends; paste an image to share it

**Hosting & moderation**
- **Waiting room:** the host approves join requests (approve, deny, admit-all), with a re-admit list so an accidental deny or removal is recoverable
- **Host controls:** force-mute, pause video, remove a participant, and mute-everyone; removals are durable (a kicked user can't rejoin by reloading)
- **Broadcast mode:** one-to-many rooms where only the host publishes A/V and everyone else joins as a chat-only viewer (no camera/mic prompt)
- **Raise hand:** a shared, fairly ordered (first-raised-first) hand queue visible to the whole room

**On-device intelligence & privacy**
- **AI notes:** opt-in, consent-announced live transcription and meeting summaries that run entirely in the browser. Each participant's speech is transcribed on their own device (Whisper via transformers.js, WebGPU with a WASM fallback) and only the resulting text lines are shared; the summary model (WebLLM / the browser's built-in Prompt API) runs in-tab. Audio never leaves the machine, and the transcript exports to Markdown.
- On-device background blur (MediaPipe selfie segmentation)
- On-device RNNoise suppression, optional and off by default
- Dynacast so the publisher pauses simulcast layers no one is watching

A note on noise suppression: the browser's native suppression is light and always on. RNNoise is a heavier ML pass that can strain a slower machine and introduce robotic artifacts for the people listening, so it stays off by default and is there if you want it.

## Tech Stack

| | |
|---|---|
| Framework | Next.js 15 (App Router, TypeScript strict) |
| UI | React 19, Tailwind CSS v4, shadcn/ui (Base UI), lucide-react |
| SFU | LiveKit: `livekit-client` (browser) + `livekit-server-sdk` (token minting) |
| Noise suppression | `@sapphi-red/web-noise-suppressor` (RNNoise WASM AudioWorklet) |
| Background blur | `@mediapipe/selfie_segmentation` (self-hosted WASM) |
| Transcription | `@huggingface/transformers` (Whisper, WebGPU/WASM, in a worker) |
| Summarization | `@mlc-ai/web-llm` (WebGPU) or the browser's built-in Prompt API |
| Backend | Supabase: Auth, PostgreSQL with RLS (rooms, join requests) |
| Tests | Vitest (call logic, API routes, notes protocol, grid math) |
| Deploy | Vercel + LiveKit Cloud |

## Architecture

```
   Browser A ──publish──▶ ┌───────────────┐ ──forward──▶ Browser B, C, D...
   Browser B ──publish──▶ │  LiveKit SFU  │ ──forward──▶ Browser A, C, D...
   Browser C ──publish──▶ │ (media server)│ ──forward──▶ ...
                          └───────────────┘
   Each client uploads ONE stream. The SFU fans it out.

   Supabase = auth + room metadata only.
   /api/livekit-token mints a short-lived token after verifying auth + room.
```

- **LiveKit** handles signaling, ICE, TURN, and selective forwarding, with no `simple-peer`, no manual ICE, and no self-run TURN.
- **The token route** (`/api/livekit-token`) is auth-gated. It verifies the room is real, active, and unexpired, then mints a token scoped to that room. The API key and secret are server-only and never reach the client bundle.
- **Local media is processed on-device** (RNNoise + blur) and the processed tracks are published to the SFU via `room.localParticipant.publishTrack`.
- **Chat rides LiveKit data channels** (`publishData` with a `chat` topic) and is never persisted.

## Getting Started

### Prerequisites

- Node.js 20+ and npm
- A [Supabase](https://supabase.com) project (free tier)
- A [LiveKit Cloud](https://cloud.livekit.io) project (free "Build" tier)

### 1. Install

```bash
npm install
```

### 2. Configure environment

Copy the example and fill in your values:

```bash
cp .env.local.example .env.local
```

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL (Project Settings, API) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | Supabase publishable key (`sb_publishable_...`). The legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` also works. |
| `NEXT_PUBLIC_LIVEKIT_URL` | yes | LiveKit Cloud URL, e.g. `wss://your-project.livekit.cloud` |
| `LIVEKIT_API_KEY` | yes | LiveKit API key (server-only) |
| `LIVEKIT_API_SECRET` | yes | LiveKit API secret (server-only) |
| `NEXT_PUBLIC_APP_URL` | yes | Base URL, e.g. `http://localhost:3000` |
| `SUPABASE_SERVICE_ROLE_KEY` | no | Server-only. Unused in v1. |

The app validates required variables on startup and throws a descriptive error if any are missing.

### 3. Set up Supabase

1. **Run the migrations, in order.** In the Supabase SQL Editor, run each file in [`supabase/migrations/`](supabase/migrations) from oldest to newest:
   - `20240001_initial.sql`: `rooms` table + RLS
   - `20240002_large_rooms.sql`: raises the participant cap to 50 (ceiling 100)
   - `20240003_waiting_room.sql`: `room_join_requests` table + the waiting-room flag
   - `20240004_broadcast.sql`: the broadcast-room flag
   - `20240005_security_hardening.sql`: owner-only room reads + a `get_active_room_by_slug` lookup, and durable-ban policies
   - `20240006_readmit.sql`: lets a host lift a ban (re-admit)
2. **Auth, URL Configuration.** Set Site URL to `http://localhost:3000` and add `http://localhost:3000/**` to Redirect URLs.
3. **Magic link** works out of the box. For **Google OAuth** (optional), create a Google Cloud OAuth client with redirect `https://<project-ref>.supabase.co/auth/v1/callback`, then enable Google under Auth, Providers.

### 4. Set up LiveKit Cloud

1. Create a project at [cloud.livekit.io](https://cloud.livekit.io) (free tier).
2. From project settings, copy the **URL**, **API Key**, and **API Secret** into `.env.local`. The URL is public; the key and secret are server-only.

### 5. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

> Testing two participants on one machine? Use two different browsers, or launch a second Chrome with a fake camera so both have video:
> ```
> chrome --user-data-dir=/tmp/air-test --use-fake-device-for-media-stream --use-fake-ui-for-media-stream http://localhost:3000
> ```

## Scripts

```bash
npm run dev         # dev server
npm run build       # production build
npm run start       # serve the production build
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm test            # Vitest (run once)
npm run test:watch  # Vitest (watch mode)
```

## Deploy to Vercel

1. Push to GitHub and import the repo in Vercel.
2. Add every environment variable from `.env.local` to the Vercel project. Set `NEXT_PUBLIC_APP_URL` to your production URL.
3. In Supabase Auth, URL Configuration, add your production URL and `https://<your-domain>/**` to the redirect allow-list.
4. Deploy, then run a full multi-device call to verify.

## Project Structure

```
app/
  (auth)/login, (auth)/auth/callback   Auth UI and OAuth/magic-link callback
  room/new, room/[slug]                Create and join rooms
  api/livekit-token                    Server-side token minting (auth, ban, and capacity gated)
  api/livekit-room                     Host moderation (mute, remove, mute-all) via the LiveKit server API
components/call/                        VideoTile, PaginatedGrid, ControlBar, ChatPanel, ParticipantsPanel, NotesPanel, ...
lib/webrtc/                             MediaManager, NoiseSuppressor, BackgroundProcessor
lib/notes/                              On-device transcription + summary (audio VAD, Whisper worker, WebLLM, export)
hooks/                                  useCall (LiveKit), useMedia, useParticipants, useWaitingRoom, useAudioLevel
lib/supabase/                           Browser and server clients (@supabase/ssr)
middleware.ts                          Protects /room/* routes
supabase/migrations/                   rooms, join requests, RLS, waiting room, broadcast, security hardening
tests/                                  Vitest suite (routes, call logic, notes, grid)
public/noise/                          RNNoise worklet and WASM
public/mediapipe/                      Selfie segmentation model and WASM
```

## Security

- The token route is auth-gated and verifies room membership before minting.
- `LIVEKIT_API_SECRET` is server-only and never enters the client bundle.
- All DB access goes through the authenticated Supabase client; RLS enforces room access.
- **Rooms are readable only by their creator.** Join-by-link resolves a slug through a `SECURITY DEFINER` function that returns only the exact-slug row, so no one can enumerate rooms or harvest slugs.
- Room slugs are `nanoid`-generated, so they are non-guessable and non-sequential.
- **LiveKit identities are namespaced per user** (an HMAC tag over the user id), so no participant can present another's identity to force them off the SFU.
- **Removals and denials are durable.** A kicked or denied user is refused a fresh token unconditionally (reloading doesn't get them back in), and only the host can lift the ban (re-admit).
- **Capacity is enforced server-side.** The token route counts real SFU participants and refuses once the room is full, so a modified client can't exceed the cap.
- Every inbound data-channel payload (chat, hand, notes) is treated as untrusted: length-capped, sanitized, and attributed to the SFU-verified sender, never to a field in the payload.
- Middleware protects all `/room/*` routes.
- The UI is honest that media is server-relayed, not peer-to-peer private.
- Chat and transcripts are ephemeral: never written to a database, gone when the call ends. AI transcription and summarization run entirely on participants' devices; audio is never uploaded.
- Display names are trimmed and length-capped.

## License

Personal and other noncommercial use only, under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, modify, and share Air for personal projects, study, and other noncommercial purposes at no cost.

**Commercial use requires prior written permission from the author.** If you want to use Air (or a derivative) in or for a business, or in any way primarily intended for commercial advantage, contact Abhijeet Pachpute to arrange a commercial license.
