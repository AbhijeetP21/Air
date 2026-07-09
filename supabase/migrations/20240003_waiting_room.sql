-- Air: waiting room.
--
-- When rooms.waiting_room is on, non-host joiners must be approved by the
-- host before the token route will mint them a LiveKit token. Requests live in
-- room_join_requests; the joiner polls the token route while pending, and the
-- host approves/denies from the participants panel.

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS waiting_room BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE public.room_join_requests (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      UUID        NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  status       TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'denied')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, user_id)
);

ALTER TABLE public.room_join_requests ENABLE ROW LEVEL SECURITY;

-- A joiner may file a request for themselves. Status is fixed at 'pending' by
-- default and they get no UPDATE policy, so a denied user can't reset
-- themselves back to pending.
CREATE POLICY "Users can request to join"
  ON public.room_join_requests FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid() AND status = 'pending');

CREATE POLICY "Users can read their own requests"
  ON public.room_join_requests FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- The room's creator moderates the queue.
CREATE POLICY "Hosts can read requests for their rooms"
  ON public.room_join_requests FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_id AND r.created_by = auth.uid()
    )
  );

CREATE POLICY "Hosts can update requests for their rooms"
  ON public.room_join_requests FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_id AND r.created_by = auth.uid()
    )
  );

CREATE INDEX room_join_requests_room_status_idx
  ON public.room_join_requests(room_id, status);
