-- Air: security hardening.
--
-- Closes three holes:
--   1. Room enumeration — the old rooms SELECT policy let any authenticated
--      user read EVERY active room (and thus every slug). Join-by-link is the
--      whole access model, so slugs must stay secret. We restrict SELECT to the
--      creator and move slug lookups to a SECURITY DEFINER function that returns
--      only the single row whose exact slug you already know (no enumeration).
--   2. Durable kick — a removed user could rejoin instantly in a room with the
--      waiting room off. Kicks now record a 'denied' ban row (see the upsert in
--      the livekit-room route), and the token route enforces it unconditionally.
--      This INSERT needs a host policy, added below.
--   3. Hardening — explicit WITH CHECK on host UPDATE so the upsert's update
--      path is unambiguous.

-- ---------------------------------------------------------------------------
-- 1. Rooms: owner-only SELECT + a slug-lookup RPC that bypasses it safely.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Authenticated users can read active rooms" ON public.rooms;

CREATE POLICY "Users can read their own rooms"
  ON public.rooms FOR SELECT
  TO authenticated
  USING (created_by = auth.uid());

-- Returns the one active, unexpired room matching an EXACT slug, or nothing.
-- SECURITY DEFINER so it runs past the owner-only SELECT policy — but it can
-- only ever return a row the caller already named by slug, so it exposes no
-- more than the join link itself does. It cannot list or pattern-match rooms.
CREATE OR REPLACE FUNCTION public.get_active_room_by_slug(p_slug text)
  RETURNS public.rooms
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT *
  FROM public.rooms
  WHERE slug = p_slug
    AND is_active = TRUE
    AND (expires_at IS NULL OR expires_at > NOW())
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_active_room_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_room_by_slug(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Join requests: let a host record a ban (a 'denied' row) for a kicked user
--    who never filed a request, so removal is durable even with the waiting
--    room off. The existing self-INSERT policy only allows status='pending'
--    for the caller's own row, so this is additive and can't be abused by a
--    non-host (the EXISTS check pins it to rooms they own).
-- ---------------------------------------------------------------------------

CREATE POLICY "Hosts can ban users from their rooms"
  ON public.room_join_requests FOR INSERT
  TO authenticated
  WITH CHECK (
    status = 'denied'
    AND EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_id AND r.created_by = auth.uid()
    )
  );

-- 3. Make the host UPDATE policy's post-image explicit (the upsert update path
--    relies on it). Same rule as before, now stated as WITH CHECK too.
DROP POLICY IF EXISTS "Hosts can update requests for their rooms" ON public.room_join_requests;

CREATE POLICY "Hosts can update requests for their rooms"
  ON public.room_join_requests FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_id AND r.created_by = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_id AND r.created_by = auth.uid()
    )
  );
