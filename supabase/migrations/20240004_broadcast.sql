-- Broadcast rooms: one-to-many sessions where only the host publishes
-- audio/video. Everyone else joins as a viewer — no mic/camera, chat only.
-- The flag is set at creation and enforced server-side in the token route
-- (viewers get canPublish: false in their LiveKit grant).

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS broadcast BOOLEAN NOT NULL DEFAULT FALSE;
