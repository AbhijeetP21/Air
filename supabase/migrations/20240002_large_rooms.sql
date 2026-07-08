-- Air: large rooms.
--
-- Pact capped rooms at a P2P-mesh-friendly size. Air runs on an SFU, so a
-- single upstream fans out to everyone — lift the cap to 50 by default
-- (architecture scales to 100+).

ALTER TABLE public.rooms
  DROP CONSTRAINT IF EXISTS rooms_max_participants_check;

ALTER TABLE public.rooms
  ALTER COLUMN max_participants SET DEFAULT 50,
  ADD CONSTRAINT rooms_max_participants_check
    CHECK (max_participants BETWEEN 1 AND 100);
