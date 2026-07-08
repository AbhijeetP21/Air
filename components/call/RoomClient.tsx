'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Aperture,
  ArrowRight,
  AudioLines,
  Check,
  Copy,
  Loader2,
  Maximize,
  Minimize,
  MonitorX,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'

import { useCall } from '@/hooks/useCall'
import { useAudioLevel } from '@/hooks/useAudioLevel'
import { useDeviceCapabilities } from '@/hooks/useDeviceCapabilities'
import { useWakeLock } from '@/hooks/useWakeLock'
import { cn, getRoomUrl, isWebRTCSupported } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { ChatPanel } from '@/components/call/ChatPanel'
import { ControlBar } from '@/components/call/ControlBar'
import { LocalPreview } from '@/components/call/LocalPreview'
import { ParticipantGrid } from '@/components/call/ParticipantGrid'
import { PaginatedGrid } from '@/components/call/PaginatedGrid'
import { ParticipantsPanel } from '@/components/call/ParticipantsPanel'
import { SpotlightView } from '@/components/call/SpotlightView'

// At or below this count, use the hand-tuned ParticipantGrid layouts; above it,
// switch to the paginated grid built for large rooms.
const SMALL_ROOM_MAX = 5
// Cap the spotlight filmstrip so a 50-person room doesn't mount 49 thumbnails.
const SPOTLIGHT_FILMSTRIP_MAX = 8

export type RoomClientProps = {
  slug: string
  roomName: string | null
  maxParticipants: number
  /** The room creator's user id — gates host moderation controls. */
  hostId: string
  user: {
    id: string
    displayName: string
    avatarUrl: string | null
  }
}

export function RoomClient(props: RoomClientProps) {
  // Resolved after mount to avoid an SSR/client mismatch. null = still checking.
  const [supported, setSupported] = useState<boolean | null>(null)
  useEffect(() => setSupported(isWebRTCSupported()), [])

  if (supported === null) {
    return (
      <CenteredMessage
        icon={<Loader2 className="size-6 animate-spin text-primary" />}
        title="Loading…"
        body=""
      />
    )
  }

  if (!supported) {
    return (
      <CenteredMessage
        icon={<MonitorX className="size-6 text-muted-foreground" />}
        title="This browser isn't supported"
        body="Air needs WebRTC and camera/microphone access. Try the latest Chrome, Edge, Firefox, or Safari."
        action={
          <Link href="/" className={cn(buttonVariants({ variant: 'outline' }))}>
            Back to home
          </Link>
        }
      />
    )
  }

  return <CallExperience {...props} />
}

function CallExperience({
  slug,
  roomName,
  maxParticipants,
  hostId,
  user,
}: RoomClientProps) {
  const {
    participants,
    mediaState,
    callStatus,
    inLobby,
    roomFull,
    selfPeerId,
    chatMessages,
    sendChat,
    handRaised,
    toggleHand,
    setVisibleParticipants,
    join,
    toggleAudio,
    toggleVideo,
    switchCamera,
    toggleNoiseSuppression,
    toggleBackgroundBlur,
    startScreenShare,
    stopScreenShare,
    leaveCall,
  } = useCall({ slug, maxParticipants, user })

  const isHost = user.id === hostId

  const { isMobile, canScreenShare } = useDeviceCapabilities()

  // Keep the screen awake while in an active call (esp. on phones).
  useWakeLock(callStatus === 'connected' || callStatus === 'reconnecting')

  // Local speaking drives the local tile ring and the mic button pulse.
  const localSpeaking = useAudioLevel(
    mediaState.localStream,
    mediaState.audioEnabled,
  )

  // Spotlight (speaker view) + fullscreen.
  const rootRef = useRef<HTMLDivElement>(null)
  const [focusedPeerId, setFocusedPeerId] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)

  async function copyInviteLink() {
    try {
      await navigator.clipboard.writeText(getRoomUrl(slug))
      setLinkCopied(true)
      toast.success('Room link copied')
      setTimeout(() => setLinkCopied(false), 2000)
    } catch {
      toast.error('Could not copy the link')
    }
  }

  // Session chat: track unread while the panel is closed.
  const [chatOpen, setChatOpen] = useState(false)
  const [seenCount, setSeenCount] = useState(0)
  useEffect(() => {
    if (chatOpen) setSeenCount(chatMessages.length)
  }, [chatOpen, chatMessages.length])
  const chatUnread = chatOpen ? 0 : Math.max(0, chatMessages.length - seenCount)

  // Participant roster panel + host moderation. Opening the panel closes chat
  // and vice-versa so they never overlap on the same right rail.
  const [participantsOpen, setParticipantsOpen] = useState(false)

  const moderate = useCallback(
    async (action: 'mute' | 'remove' | 'mute-all', targetIdentity?: string) => {
      try {
        const res = await fetch('/api/livekit-room', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, action, targetIdentity }),
        })
        if (!res.ok) throw new Error(`status ${res.status}`)
      } catch {
        toast.error("That didn't work. Try again.")
      }
    },
    [slug],
  )

  // Auto-spotlight our own screen share while it's active.
  useEffect(() => {
    if (mediaState.screenSharing) setFocusedPeerId(selfPeerId)
    else setFocusedPeerId((prev) => (prev === selfPeerId ? null : prev))
  }, [mediaState.screenSharing, selfPeerId])

  // Drop focus if the spotlighted participant leaves.
  useEffect(() => {
    if (focusedPeerId && !participants.some((p) => p.peerId === focusedPeerId)) {
      setFocusedPeerId(null)
    }
  }, [participants, focusedPeerId])

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    } else {
      void rootRef.current?.requestFullscreen().catch(() => {})
    }
  }

  const isSpotlight =
    focusedPeerId !== null &&
    participants.some((p) => p.peerId === focusedPeerId)

  const usesPagination = participants.length > SMALL_ROOM_MAX

  // For large rooms, order by recent speaker (local always first) so the most
  // relevant people land on page 1. Small rooms keep the stable roster order to
  // avoid tiles hopping around.
  const orderedParticipants = useMemo(() => {
    if (!usesPagination) return participants
    return [...participants].sort((a, b) => {
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1
      const at = a.lastSpokeAt ?? 0
      const bt = b.lastSpokeAt ?? 0
      if (at !== bt) return bt - at
      return a.peerId.localeCompare(b.peerId)
    })
  }, [participants, usesPagination])

  // In spotlight, cap the filmstrip: the focused tile plus the top-N others.
  const spotlightParticipants = useMemo(() => {
    if (!focusedPeerId) return orderedParticipants
    const focused = orderedParticipants.find((p) => p.peerId === focusedPeerId)
    const others = orderedParticipants
      .filter((p) => p.peerId !== focusedPeerId)
      .slice(0, SPOTLIGHT_FILMSTRIP_MAX)
    return focused ? [focused, ...others] : others
  }, [orderedParticipants, focusedPeerId])

  // Identities on screen right now — the grid page, the spotlight set, or (small
  // room) everyone. The call hook subscribes remote video only for these.
  const [pageVisibleIds, setPageVisibleIds] = useState<string[]>([])
  const visibleIds = useMemo(() => {
    if (isSpotlight) return spotlightParticipants.map((p) => p.peerId)
    if (!usesPagination) return participants.map((p) => p.peerId)
    return pageVisibleIds
  }, [isSpotlight, usesPagination, spotlightParticipants, participants, pageVisibleIds])

  const visibleKey = visibleIds.join(',')
  useEffect(() => {
    setVisibleParticipants(visibleKey ? visibleKey.split(',') : [])
  }, [visibleKey, setVisibleParticipants])

  const handleVisibleChange = useCallback(
    (ids: string[]) => setPageVisibleIds(ids),
    [],
  )

  // Mirror the local tile only for the front camera with no screen share —
  // a mirrored rear camera (or shared screen) reads as reversed/wrong.
  const mirrorLocal =
    !mediaState.screenSharing && mediaState.facingMode === 'user'

  if (callStatus === 'acquiring-media') {
    return (
      <CenteredMessage
        icon={<Loader2 className="size-6 animate-spin text-primary" />}
        title="Setting up your camera and microphone"
        body="Allow access when your browser asks."
      />
    )
  }

  if (callStatus === 'error') {
    return (
      <CenteredMessage
        title="We couldn't start your call"
        body="Camera/microphone access was blocked, or the room signaling channel failed. Check permissions and reload."
        action={
          <Link href="/" className={cn(buttonVariants({ variant: 'outline' }))}>
            Back to home
          </Link>
        }
      />
    )
  }

  // Lobby: media is ready, but we haven't joined the room yet.
  if (inLobby) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-4 py-10">
        <div className="w-full max-w-lg space-y-6">
          <div className="space-y-1 text-center">
            <h1 className="text-xl font-semibold tracking-tight">
              {roomName ?? 'Private room'}
            </h1>
            <p className="text-sm text-muted-foreground">
              Ready when you are, {user.displayName}.
            </p>
          </div>

          <LocalPreview
            mediaState={mediaState}
            displayName={user.displayName}
            avatarUrl={user.avatarUrl}
            onToggleAudio={toggleAudio}
            onToggleVideo={toggleVideo}
          />

          {roomFull ? (
            <div className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-center">
              <p className="text-sm font-medium text-destructive">
                This room is full ({maxParticipants}/{maxParticipants}{' '}
                participants)
              </p>
              <Link
                href="/"
                className={cn(buttonVariants({ variant: 'outline' }), 'w-full')}
              >
                Back to home
              </Link>
            </div>
          ) : (
            <>
              {/* Effects are CPU-heavy; hidden on mobile to protect battery. */}
              {!isMobile && (
                <div className="space-y-2">
                  <LobbyToggle
                    icon={<AudioLines className="size-4 text-primary" />}
                    title="Noise cancellation"
                    description="Removes steady background noise on-device. Best left off on a fast connection."
                    checked={mediaState.noiseSuppression}
                    onToggle={() => void toggleNoiseSuppression()}
                  />
                  <LobbyToggle
                    icon={<Aperture className="size-4 text-primary" />}
                    title="Blur my background"
                    description="Hides your surroundings on-device."
                    checked={mediaState.backgroundBlur}
                    onToggle={() => void toggleBackgroundBlur()}
                  />
                </div>
              )}

              <Button
                size="lg"
                className="h-12 w-full text-base"
                onClick={() => void join()}
              >
                Join call
                <ArrowRight className="size-4" />
              </Button>
            </>
          )}
        </div>
      </main>
    )
  }

  // Active call (connecting / connected / reconnecting).
  return (
    <div ref={rootRef} className="flex h-dvh flex-col bg-background">
      <header className="flex items-center justify-between gap-4 px-6 py-4">
        <div>
          <h1 className="text-sm font-medium">{roomName ?? 'Private room'}</h1>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="size-3.5" />
            {participants.length} / {maxParticipants}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5">
            <span
              className={cn(
                'inline-block size-1.5 rounded-full',
                callStatus === 'connected'
                  ? 'bg-green-500'
                  : 'animate-pulse bg-amber-500',
              )}
            />
            {callStatus === 'connected'
              ? 'Connected'
              : callStatus === 'reconnecting'
                ? 'Reconnecting…'
                : 'Connecting…'}
          </Badge>
          <button
            type="button"
            onClick={() => void copyInviteLink()}
            aria-label="Copy room link"
            title="Copy room link to invite others"
            className="flex size-8 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {linkCopied ? (
              <Check className="size-4 text-green-500" />
            ) : (
              <Copy className="size-4" />
            )}
          </button>
          {!isMobile && (
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              className="flex size-8 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {isFullscreen ? (
                <Minimize className="size-4" />
              ) : (
                <Maximize className="size-4" />
              )}
            </button>
          )}
        </div>
      </header>

      <main className="flex flex-1 flex-col overflow-y-auto px-4 pb-28">
        <div className="flex min-h-0 w-full flex-1 items-center justify-center">
          {isSpotlight && focusedPeerId ? (
            <SpotlightView
              participants={spotlightParticipants}
              focusedPeerId={focusedPeerId}
              mirrorLocal={mirrorLocal}
              localSpeaking={localSpeaking}
              onFocus={setFocusedPeerId}
              onExit={() => setFocusedPeerId(null)}
            />
          ) : usesPagination ? (
            <PaginatedGrid
              participants={orderedParticipants}
              mirrorLocal={mirrorLocal}
              localSpeaking={localSpeaking}
              onFocus={setFocusedPeerId}
              onVisibleChange={handleVisibleChange}
            />
          ) : (
            <ParticipantGrid
              participants={participants}
              mirrorLocal={mirrorLocal}
              localSpeaking={localSpeaking}
              onFocus={setFocusedPeerId}
            />
          )}
        </div>
      </main>

      <ControlBar
        mediaState={mediaState}
        localSpeaking={localSpeaking}
        chatOpen={chatOpen}
        chatUnread={chatUnread}
        isMobile={isMobile}
        canScreenShare={canScreenShare}
        onToggleAudio={toggleAudio}
        onToggleVideo={toggleVideo}
        onFlipCamera={() => void switchCamera()}
        onToggleScreenShare={() => {
          if (mediaState.screenSharing) void stopScreenShare()
          else void startScreenShare()
        }}
        onToggleNoiseSuppression={() => void toggleNoiseSuppression()}
        onToggleBackgroundBlur={() => void toggleBackgroundBlur()}
        handRaised={handRaised}
        participantsOpen={participantsOpen}
        onToggleChat={() => {
          setChatOpen((o) => !o)
          setParticipantsOpen(false)
        }}
        onToggleHand={toggleHand}
        onToggleParticipants={() => {
          setParticipantsOpen((o) => !o)
          setChatOpen(false)
        }}
        onLeave={() => void leaveCall()}
      />

      <ChatPanel
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        messages={chatMessages}
        selfPeerId={selfPeerId}
        onSend={sendChat}
      />

      <ParticipantsPanel
        open={participantsOpen}
        onClose={() => setParticipantsOpen(false)}
        participants={participants}
        selfPeerId={selfPeerId}
        hostId={hostId}
        isHost={isHost}
        onFocus={setFocusedPeerId}
        onMute={(identity) => void moderate('mute', identity)}
        onRemove={(identity) => void moderate('remove', identity)}
        onMuteAll={() => void moderate('mute-all')}
      />
    </div>
  )
}

function LobbyToggle({
  icon,
  title,
  description,
  checked,
  onToggle,
}: {
  icon: React.ReactNode
  title: string
  description: string
  checked: boolean
  onToggle: () => void
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        {icon}
        <div className="text-sm">
          <p className="font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={onToggle}
        className={cn(
          'inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors',
          checked ? 'bg-primary' : 'bg-muted',
        )}
      >
        <span
          className={cn(
            'inline-block size-5 rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </button>
    </div>
  )
}

function CenteredMessage({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      {icon}
      <div className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {body && <p className="max-w-sm text-sm text-muted-foreground">{body}</p>}
      </div>
      {action}
    </main>
  )
}
