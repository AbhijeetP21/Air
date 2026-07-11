'use client'

import { Hand, Maximize2, MicOff, VideoOff } from 'lucide-react'

import { useAudioLevel } from '@/hooks/useAudioLevel'
import { cn, initialsFromName } from '@/lib/utils'
import type { Participant } from '@/types'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ConnectionBadge } from '@/components/call/ConnectionBadge'
import { StreamVideo } from '@/components/call/StreamVideo'

/**
 * A single participant tile: live video (or avatar fallback), name overlay,
 * mic/camera status, connection badge, and a speaking ring. The local tile is
 * visually distinct (violet ring + "You") and muted to prevent echo.
 */
export function VideoTile({
  participant,
  mirror,
  localSpeaking,
  objectFit = 'cover',
  compact = false,
  onExpand,
}: {
  participant: Participant
  mirror: boolean
  /** Pre-computed speaking state for the local tile (avoids a 2nd AudioContext). */
  localSpeaking?: boolean
  objectFit?: 'cover' | 'contain'
  /** Smaller overlays for thumbnail/PiP use. */
  compact?: boolean
  /** When set, shows a hover "expand" button that spotlights this tile. */
  onExpand?: () => void
}) {
  // Require an actual video track, not just a stream: under selective
  // subscription a remote's stream exists as soon as their AUDIO track attaches,
  // while the video track arrives later — rendering <video> in that window would
  // show a black rectangle instead of the avatar. Gate on a present video track.
  const showVideo = Boolean(
    participant.videoEnabled &&
      participant.stream &&
      participant.stream.getVideoTracks().length > 0,
  )

  // Remote tiles analyse their own incoming audio; the local tile reuses the
  // value computed once by the parent.
  const remoteSpeaking = useAudioLevel(
    participant.isLocal ? null : participant.stream,
    participant.audioEnabled,
  )
  const speaking =
    (participant.isLocal ? localSpeaking : remoteSpeaking) ?? false

  return (
    <div
      className={cn(
        'group relative size-full overflow-hidden rounded-xl border bg-zinc-900 transition-shadow duration-150',
        participant.isLocal && !speaking && 'border-primary/40',
        speaking
          ? 'border-primary shadow-[0_0_0_2px_var(--color-primary)]'
          : !participant.isLocal && 'border-white/[0.08]',
      )}
    >
      {showVideo ? (
        // Always muted: remote audio plays through dedicated off-DOM audio
        // elements managed by useCall (so off-page participants stay audible
        // under pagination). An unmuted tile here would double-play them.
        <StreamVideo
          stream={participant.stream}
          muted
          mirror={mirror}
          objectFit={objectFit}
        />
      ) : (
        <div className="flex size-full items-center justify-center">
          <Avatar
            className={cn(
              'transition-transform',
              compact ? 'size-10' : 'size-20',
              speaking && 'ring-2 ring-primary',
            )}
          >
            {participant.avatarUrl ? (
              <AvatarImage src={participant.avatarUrl} alt={participant.displayName} />
            ) : null}
            <AvatarFallback className={compact ? 'text-sm' : 'text-2xl'}>
              {initialsFromName(participant.displayName)}
            </AvatarFallback>
          </Avatar>
        </div>
      )}

      {/* Always visible on touch screens (there's no hover to reveal it);
          desktop keeps the tidier hover-only reveal. Spotlighting is ONLY this
          button — a stray tap on the tile can't hijack the layout. */}
      {onExpand && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onExpand()
          }}
          aria-label="Expand"
          className="absolute left-2 top-2 block rounded-md bg-black/55 p-1.5 text-white backdrop-blur transition-colors hover:bg-black/75 sm:hidden sm:group-hover:block"
        >
          <Maximize2 className="size-3.5" />
        </button>
      )}

      {/* Top-right status: raised hand + connection (remote) + camera-off. */}
      <div className="absolute right-2 top-2 flex items-center gap-1.5">
        {participant.handRaised && (
          <span
            className={cn(
              'flex animate-bounce items-center gap-1 rounded-md bg-primary p-1.5 shadow-lg',
              !compact && 'px-2',
            )}
          >
            <Hand className="size-4 text-primary-foreground" />
            {!compact && (
              <span className="text-xs font-medium text-primary-foreground">
                Hand raised
              </span>
            )}
          </span>
        )}
        {!participant.videoEnabled && (
          <span className="rounded-md bg-black/55 p-1 backdrop-blur">
            <VideoOff className="size-3.5 text-white/90" />
          </span>
        )}
        {!participant.isLocal && (
          <span className="rounded-md bg-black/55 p-1.5 backdrop-blur">
            <ConnectionBadge state={participant.connectionState} />
          </span>
        )}
      </div>

      {/* Bottom-left: name + mic state. */}
      <div
        className={cn(
          'absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-black/50 px-2 py-1 text-white backdrop-blur',
          compact ? 'text-[10px]' : 'text-xs',
        )}
      >
        {!participant.audioEnabled && <MicOff className="size-3 text-red-400" />}
        <span className={cn('truncate', compact ? 'max-w-[6rem]' : 'max-w-[12rem]')}>
          {participant.displayName}
          {participant.isLocal ? ' (You)' : ''}
        </span>
      </div>
    </div>
  )
}
