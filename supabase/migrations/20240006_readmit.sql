-- Air: host re-admit (lift a ban).
--
-- Kicks and waiting-room denials both write a 'denied' row (see 20240005 and
-- the livekit-room route). Without a way to clear it, an accidental Deny or
-- kick is permanent. Let a host DELETE a request row for their own room — the
-- host UI exposes this as "re-admit", after which the user can rejoin (normal
-- room) or ask again (waiting room).

CREATE POLICY "Hosts can clear requests for their rooms"
  ON public.room_join_requests FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_id AND r.created_by = auth.uid()
    )
  );
