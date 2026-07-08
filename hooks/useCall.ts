'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { nanoid } from 'nanoid'
import { toast } from 'sonner'
import {
  ConnectionState,
  DisconnectReason,
  RoomEvent,
  Track,
  type DataPublishOptions,
  type LocalTrackPublication,
  type Participant as LKParticipant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  type TrackPublication,
} from 'livekit-client'

import { useMedia } from '@/hooks/useMedia'
import { useParticipants } from '@/hooks/useParticipants'
import { MAX_DISPLAY_NAME_LENGTH } from '@/lib/utils'
import { sanitizeChatImage } from '@/lib/chat/image'
import { rtcError, rtcLog } from '@/lib/webrtc/log'
import type {
  CallStatus,
  ChatImage,
  ChatMessage,
  MediaState,
  Participant,
  PresencePayload,
} from '@/types'

// Max characters per chat message (same on send and receive).
const MAX_CHAT_LENGTH = 2000
// Cap on messages retained in memory. Untrusted peers could otherwise flood the
// room; we keep only the most recent. A message count, not a character limit.
const MAX_CHAT_MESSAGES = 1000
// LiveKit data-channel topics.
const CHAT_TOPIC = 'chat'
const HAND_TOPIC = 'hand'

export type UseCallParams = {
  slug: string
  maxParticipants: number
  user: { id: string; displayName: string; avatarUrl: string | null }
}

export type UseCallReturn = {
  participants: Participant[]
  localStream: MediaStream | null
  mediaState: MediaState
  callStatus: CallStatus
  selfPeerId: string
  /** Media ready, lobby shown, but not yet connected to the room. */
  inLobby: boolean
  /** Room is at capacity — joining is blocked. */
  roomFull: boolean
  /** Ephemeral session chat (not persisted; cleared on leave). */
  chatMessages: ChatMessage[]
  sendChat: (text: string, image?: ChatImage) => void
  /** Whether the local user's hand is raised. */
  handRaised: boolean
  /** Toggle the local raised hand (broadcast to the room over a data channel). */
  toggleHand: () => void
  /**
   * Report the identities currently on screen so the SFU subscription can be
   * scoped to them (audio stays subscribed for everyone). Safe to call every
   * render; it only reconciles when the set actually changes upstream.
   */
  setVisibleParticipants: (ids: string[]) => void
  join: () => Promise<void>
  toggleAudio: () => void
  toggleVideo: () => void
  switchCamera: () => Promise<void>
  toggleNoiseSuppression: () => Promise<void>
  toggleBackgroundBlur: () => Promise<void>
  startScreenShare: () => Promise<void>
  stopScreenShare: () => void
  leaveCall: () => Promise<void>
}

/** Append a chat message, keeping at most MAX_CHAT_MESSAGES (drops oldest). */
function appendChat(prev: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const next = [...prev, message]
  return next.length > MAX_CHAT_MESSAGES
    ? next.slice(next.length - MAX_CHAT_MESSAGES)
    : next
}

/** Fetch a short-lived LiveKit token for this room from the server route. */
async function fetchToken(
  slug: string,
  sessionId: string,
): Promise<{ token: string; url: string }> {
  const res = await fetch('/api/livekit-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, sessionId }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `token request failed (${res.status})`)
  }
  return (await res.json()) as { token: string; url: string }
}

/** Parse the server-set participant metadata (see the token route). */
function parseMetadata(metadata: string | undefined): {
  userId: string | null
  avatarUrl: string | null
} {
  if (!metadata) return { userId: null, avatarUrl: null }
  try {
    const parsed = JSON.parse(metadata) as {
      userId?: unknown
      avatarUrl?: unknown
    }
    return {
      userId: typeof parsed.userId === 'string' ? parsed.userId : null,
      avatarUrl: typeof parsed.avatarUrl === 'string' ? parsed.avatarUrl : null,
    }
  } catch {
    return { userId: null, avatarUrl: null }
  }
}

/**
 * Air's call engine. Where Pact ran a peer-to-peer mesh, Air publishes one
 * upstream to a LiveKit SFU which forwards it to everyone — so upload cost is
 * O(1), not O(N), and rooms scale past a mesh's ~5-peer ceiling.
 *
 * The public shape matches Pact's `useCall` so the existing lobby, grid,
 * spotlight, control bar and chat UI keep working unchanged. Locally captured
 * media is still processed by `MediaManager` (RNNoise + background blur); the
 * processed tracks are what we publish to the SFU.
 */
export function useCall({
  slug,
  maxParticipants,
  user,
}: UseCallParams): UseCallReturn {
  const router = useRouter()
  const media = useMedia()
  const {
    participants,
    upsertFromPresence,
    patch,
    setStream,
    setConnectionState,
    remove,
    clearRemote,
    reset,
  } = useParticipants()

  // Starts in 'acquiring-media'; becomes 'idle' (lobby) once media is ready,
  // then 'connecting' → 'connected' after the user joins.
  const [callStatus, setCallStatus] = useState<CallStatus>('acquiring-media')
  const [roomFull, setRoomFull] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [handRaised, setHandRaised] = useState(false)
  // Mirror for event handlers (rebroadcast to newcomers without stale closures).
  const handRaisedRef = useRef(false)

  // Stable identity for this session. The LiveKit identity is a per-session
  // nanoid (minted into the token by the server route) — NOT the user id — so
  // the same account can join from two tabs/devices without LiveKit treating it
  // as a reconnect and kicking the first session. The trusted user id rides in
  // server-set participant metadata.
  const [self] = useState<PresencePayload>(() => ({
    peerId: nanoid(12),
    userId: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    joinedAt: new Date().toISOString(),
  }))

  const roomRef = useRef<Room | null>(null)
  // One MediaStream per remote participant, accumulating their subscribed
  // tracks (camera/mic/screen) so the existing VideoTile can bind it directly.
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map())
  // Our local publications, kept so control toggles can mute / replace tracks.
  const audioPubRef = useRef<LocalTrackPublication | null>(null)
  const videoPubRef = useRef<LocalTrackPublication | null>(null)
  // True when the video publication currently carries a screen share that we
  // published ourselves (no camera present), so stopping it should unpublish.
  const screenOwnsVideoPubRef = useRef(false)
  const cancelledRef = useRef(false)
  // Identities whose video the UI currently wants (the on-screen page). We
  // connect with autoSubscribe off and subscribe video only for these, so a
  // 50-person room never pulls 50 upstreams at once. Audio is always subscribed.
  const visibleRef = useRef<Set<string>>(new Set())

  // Reconcile every remote publication against the desired subscription state:
  // audio for everyone, video only for on-screen (visible) participants.
  const reconcileSubscriptions = useCallback(() => {
    const room = roomRef.current
    if (!room) return
    room.remoteParticipants.forEach((p) => {
      const wantVideo = visibleRef.current.has(p.identity)
      p.trackPublications.forEach((pub) => {
        if (pub.kind === Track.Kind.Audio) {
          if (!pub.isSubscribed) pub.setSubscribed(true)
        } else if (pub.kind === Track.Kind.Video) {
          if (pub.isSubscribed !== wantVideo) pub.setSubscribed(wantVideo)
        }
      })
    })
  }, [])

  // Called by the grid/spotlight with the identities it's actually rendering.
  const setVisibleParticipants = useCallback(
    (ids: string[]) => {
      visibleRef.current = new Set(ids)
      reconcileSubscriptions()
    },
    [reconcileSubscriptions],
  )

  // ---- Remote roster helpers ---------------------------------------------

  const attachTrack = useCallback(
    (identity: string, track: RemoteTrack) => {
      // Remote audio must be audible even when the participant's tile isn't
      // mounted (pagination / capped filmstrip), so every subscribed audio
      // track gets its own off-DOM <audio> element via LiveKit's attach().
      // Tiles render their <video> muted — audio plays here and only here.
      if (track.kind === Track.Kind.Audio) {
        track.attach()
      }
      // The per-participant stream still carries the audio track so the tile's
      // speaking indicator (Web Audio analyser) works; the muted <video> won't
      // double-play it.
      let stream = remoteStreamsRef.current.get(identity)
      if (!stream) {
        stream = new MediaStream()
        remoteStreamsRef.current.set(identity, stream)
      }
      if (!stream.getTracks().includes(track.mediaStreamTrack)) {
        stream.addTrack(track.mediaStreamTrack)
      }
      setStream(identity, stream)
    },
    [setStream],
  )

  const detachTrack = useCallback(
    (identity: string, track: RemoteTrack) => {
      // Release the off-DOM audio element created in attachTrack.
      if (track.kind === Track.Kind.Audio) {
        track.detach()
      }
      const stream = remoteStreamsRef.current.get(identity)
      if (!stream) return
      stream.removeTrack(track.mediaStreamTrack)
      setStream(identity, stream)
    },
    [setStream],
  )

  const applyMuteState = useCallback(
    (identity: string, pub: TrackPublication) => {
      const enabled = !pub.isMuted
      if (pub.kind === Track.Kind.Audio) patch(identity, { audioEnabled: enabled })
      else if (pub.kind === Track.Kind.Video) patch(identity, { videoEnabled: enabled })
    },
    [patch],
  )

  const addRemote = useCallback(
    (participant: RemoteParticipant) => {
      // userId + avatar come from server-set metadata (minted into the token),
      // so another participant can't forge them.
      const meta = parseMetadata(participant.metadata)
      upsertFromPresence({
        peerId: participant.identity,
        userId: meta.userId ?? participant.identity,
        displayName: participant.name || 'Guest',
        avatarUrl: meta.avatarUrl,
        joinedAt: new Date().toISOString(),
      })
      // Remotes forwarded by the SFU are, by definition, connected to us.
      setConnectionState(participant.identity, 'connected')
      participant.trackPublications.forEach((pub) => {
        applyMuteState(participant.identity, pub)
        if (pub.isSubscribed && pub.track) {
          attachTrack(participant.identity, pub.track)
        }
      })
    },
    [upsertFromPresence, setConnectionState, applyMuteState, attachTrack],
  )

  const removeRemote = useCallback(
    (identity: string) => {
      remoteStreamsRef.current.delete(identity)
      remove(identity)
    },
    [remove],
  )

  // Broadcast our raised-hand state to the room (no-op before join).
  const publishHand = useCallback(
    (raised: boolean) => {
      const room = roomRef.current
      if (!room) return
      const payload = new TextEncoder().encode(
        JSON.stringify({ peerId: self.peerId, raised }),
      )
      const opts: DataPublishOptions = { reliable: true, topic: HAND_TOPIC }
      void room.localParticipant
        .publishData(
          payload as Parameters<typeof room.localParticipant.publishData>[0],
          opts,
        )
        .catch((err) => rtcError('Call', 'hand broadcast failed', err))
    },
    [self],
  )

  // ---- Room event wiring --------------------------------------------------

  const wireRoom = useCallback(
    (room: Room) => {
      room
        .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
          rtcLog('Call', `participant joined: ${p.identity}`)
          addRemote(p)
          // A newcomer's publications need the audio/video subscription rules
          // applied (autoSubscribe is off).
          reconcileSubscriptions()
          // Hand state is event-based, so a newcomer would otherwise never
          // learn ours — re-announce it for them.
          if (handRaisedRef.current) publishHand(true)
        })
        .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
          rtcLog('Call', `participant left: ${p.identity}`)
          removeRemote(p.identity)
        })
        .on(
          RoomEvent.TrackPublished,
          (_pub: RemoteTrackPublication, _p: RemoteParticipant) => {
            // A track published after join still needs subscribing per our rules.
            reconcileSubscriptions()
          },
        )
        .on(RoomEvent.ActiveSpeakersChanged, (speakers: LKParticipant[]) => {
          const now = Date.now()
          speakers.forEach((s) => {
            if (!s.isLocal) patch(s.identity, { lastSpokeAt: now })
          })
        })
        .on(
          RoomEvent.TrackSubscribed,
          (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
            attachTrack(p.identity, track)
          },
        )
        .on(
          RoomEvent.TrackUnsubscribed,
          (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
            detachTrack(p.identity, track)
          },
        )
        .on(RoomEvent.TrackMuted, (pub: TrackPublication, p: LKParticipant) => {
          if (!p.isLocal) {
            applyMuteState(p.identity, pub)
          } else if (pub.kind === Track.Kind.Audio) {
            // The SFU muted our mic from outside (a host force-mute). Reflect it
            // locally. Our own toggles set audioEnabled *before* the publication
            // mute fires, so this is a no-op for self-initiated mutes.
            media.setAudioEnabled(false)
          }
        })
        .on(RoomEvent.TrackUnmuted, (pub: TrackPublication, p: LKParticipant) => {
          if (!p.isLocal) applyMuteState(p.identity, pub)
        })
        .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
          if (state === ConnectionState.Connected) setCallStatus('connected')
          else if (state === ConnectionState.Connecting) setCallStatus('connecting')
          else if (
            state === ConnectionState.Reconnecting ||
            state === ConnectionState.SignalReconnecting
          ) {
            setCallStatus('reconnecting')
          }
        })
        .on(
          RoomEvent.DataReceived,
          (payload: Uint8Array, p?: RemoteParticipant, _kind?: unknown, topic?: string) => {
            // Everything below keys off the SFU-verified sender identity, never
            // identity fields inside the payload — a participant can't raise
            // someone else's hand or impersonate them in chat.
            if (!p) return
            try {
              const text = new TextDecoder().decode(payload)
              if (topic === HAND_TOPIC) {
                const { raised } = JSON.parse(text) as { raised?: boolean }
                patch(p.identity, { handRaised: Boolean(raised) })
                return
              }
              if (topic !== CHAT_TOPIC) return
              const msg = JSON.parse(text) as ChatMessage
              setChatMessages((prev) =>
                // Inbound payloads are untrusted: clamp length-bearing fields
                // and cap retention so a peer can't flood us out of memory.
                appendChat(prev, {
                  ...msg,
                  from: p.identity,
                  text: String(msg.text ?? '').slice(0, MAX_CHAT_LENGTH),
                  displayName: String(msg.displayName ?? '').slice(
                    0,
                    MAX_DISPLAY_NAME_LENGTH,
                  ),
                  image: sanitizeChatImage(msg.image),
                }),
              )
            } catch (err) {
              rtcError('Call', 'malformed data payload', err)
            }
          },
        )
        .on(RoomEvent.AudioPlaybackStatusChanged, () => {
          // Autoplay policy can block the off-DOM audio elements on stricter
          // browsers. LiveKit tells us; resume on the next user gesture.
          if (room.canPlaybackAudio) return
          const resume = () => void room.startAudio().catch(() => {})
          document.addEventListener('pointerdown', resume, { once: true })
        })
        .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
          rtcLog('Call', `disconnected from room (reason ${reason})`)
          // Deliberate leave/unmount clears roomRef *before* disconnecting, so
          // anything still referenced here is an unexpected disconnect.
          if (roomRef.current !== room) return
          roomRef.current = null
          audioPubRef.current = null
          videoPubRef.current = null
          screenOwnsVideoPubRef.current = false
          remoteStreamsRef.current.clear()
          clearRemote()
          if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
            toast.error('You were removed from the call by the host.')
            router.push('/')
          } else if (reason === DisconnectReason.ROOM_DELETED) {
            toast.error('This room has been closed.')
            router.push('/')
          } else {
            // Connection lost for good (LiveKit exhausted its reconnects) —
            // back to the lobby so a manual rejoin is one click away.
            toast.error('Connection lost. Rejoin when you’re ready.')
            setCallStatus('idle')
          }
        })
    },
    [
      addRemote,
      removeRemote,
      attachTrack,
      detachTrack,
      applyMuteState,
      patch,
      reconcileSubscriptions,
      media,
      publishHand,
      clearRemote,
      router,
    ],
  )

  // ---- Phase 1: acquire media (lobby), no SFU connection yet --------------
  useEffect(() => {
    cancelledRef.current = false
    setRoomFull(false)

    async function prepare() {
      setCallStatus('acquiring-media')

      let localStream: MediaStream
      try {
        localStream = await media.acquireLocalStream()
      } catch (err) {
        if (cancelledRef.current) return
        rtcError('Call', 'media acquisition failed', err)
        setCallStatus('error')
        return
      }
      if (cancelledRef.current) return

      upsertFromPresence(self, { isLocal: true })
      setStream(self.peerId, localStream)

      // Media ready → show the lobby. Capacity is enforced at join time.
      setCallStatus('idle')
    }

    void prepare()

    return () => {
      cancelledRef.current = true
      // Null the ref *before* disconnecting — the Disconnected handler treats a
      // room still referenced by roomRef as an unexpected drop (kick/network).
      const room = roomRef.current
      roomRef.current = null
      room?.disconnect()
      audioPubRef.current = null
      videoPubRef.current = null
      screenOwnsVideoPubRef.current = false
      handRaisedRef.current = false
      setHandRaised(false)
      remoteStreamsRef.current.clear()
      media.stopAll()
      reset()
      setChatMessages([])
      setCallStatus('acquiring-media')
    }
    // Run once per room mount; all dependencies are stable refs/callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  // ---- Phase 2: connect to the SFU and publish (called from the lobby) ----
  const join = useCallback(async () => {
    if (roomRef.current) return

    setCallStatus('connecting')

    let token: string
    let url: string
    try {
      ;({ token, url } = await fetchToken(slug, self.peerId))
    } catch (err) {
      if (cancelledRef.current) return
      rtcError('Call', 'token fetch failed', err)
      setCallStatus('error')
      return
    }
    if (cancelledRef.current) return

    // dynacast lets the publisher pause simulcast layers no subscriber wants.
    //
    // adaptiveStream is intentionally OFF here: it pauses subscribed video whose
    // track has no element attached via LiveKit's `track.attach()`, but our
    // tiles bind a MediaStream through `srcObject`, so LiveKit would see no
    // consumer and freeze remote video. Phase 5 (pagination + selective
    // subscription) turns it on once tiles attach LiveKit tracks directly.
    const room = new Room({ adaptiveStream: false, dynacast: true })
    wireRoom(room)

    try {
      // autoSubscribe off: we drive subscriptions ourselves (audio for all,
      // video only for on-screen participants) so large rooms stay cheap.
      await room.connect(url, token, { autoSubscribe: false })
    } catch (err) {
      if (cancelledRef.current) return
      rtcError('Call', 'LiveKit connect failed', err)
      room.disconnect()
      setCallStatus('error')
      return
    }
    if (cancelledRef.current) {
      room.disconnect()
      return
    }

    // Capacity guard: if the room filled while we were connecting, back out.
    if (room.remoteParticipants.size + 1 > maxParticipants) {
      room.disconnect()
      setRoomFull(true)
      setCallStatus('idle')
      return
    }

    roomRef.current = room

    // Publish our processed tracks (RNNoise-cleaned audio, blurred camera).
    const audioTrack = media.managerRef.current?.getActiveAudioTrack() ?? null
    const videoTrack = media.managerRef.current?.getCameraVideoTrack() ?? null
    try {
      if (audioTrack) {
        audioPubRef.current = await room.localParticipant.publishTrack(audioTrack, {
          source: Track.Source.Microphone,
        })
        if (!media.mediaState.audioEnabled) await audioPubRef.current.mute()
      }
      if (videoTrack) {
        videoPubRef.current = await room.localParticipant.publishTrack(videoTrack, {
          source: Track.Source.Camera,
        })
        if (!media.mediaState.videoEnabled) await videoPubRef.current.mute()
      }
    } catch (err) {
      rtcError('Call', 'failed to publish local tracks', err)
    }

    // Seed the roster with everyone already in the room, then apply the
    // subscription rules (audio for all; video for whatever the grid has marked
    // visible — initially none until the grid reports its first page).
    room.remoteParticipants.forEach((p) => addRemote(p))
    reconcileSubscriptions()

    // After a lobby rejoin (post-disconnect) our hand may still be up — tell
    // the room, since only newcomers get the rebroadcast otherwise.
    if (handRaisedRef.current) publishHand(true)

    setCallStatus('connected')
    rtcLog('Call', `joined room ${slug} as ${self.peerId}`)
  }, [
    slug,
    self,
    maxParticipants,
    media,
    wireRoom,
    addRemote,
    reconcileSubscriptions,
    publishHand,
  ])

  // Keep the local participant's preview stream + mic/camera flags in sync.
  useEffect(() => {
    const previewStream =
      media.mediaState.screenSharing && media.mediaState.displayStream
        ? media.mediaState.displayStream
        : media.mediaState.localStream
    patch(self.peerId, {
      audioEnabled: media.mediaState.audioEnabled,
      videoEnabled: media.mediaState.videoEnabled,
      stream: previewStream,
    })
  }, [
    media.mediaState.audioEnabled,
    media.mediaState.videoEnabled,
    media.mediaState.screenSharing,
    media.mediaState.displayStream,
    media.mediaState.localStream,
    patch,
    self.peerId,
  ])

  // Mirror local mic state onto the SFU publication so remote tiles update.
  useEffect(() => {
    const pub = audioPubRef.current
    if (!pub) return
    if (media.mediaState.audioEnabled) void pub.unmute()
    else void pub.mute()
  }, [media.mediaState.audioEnabled])

  // Mirror local camera state (skip while a screen share owns the video sender).
  useEffect(() => {
    const pub = videoPubRef.current
    if (!pub || media.mediaState.screenSharing) return
    if (media.mediaState.videoEnabled) void pub.unmute()
    else void pub.mute()
  }, [media.mediaState.videoEnabled, media.mediaState.screenSharing])

  const sendChat = useCallback(
    (text: string, image?: ChatImage) => {
      const trimmed = text.trim()
      const room = roomRef.current
      // Allow an image-only message, but require at least one of text/image.
      if ((!trimmed && !image) || !room) return
      const message: ChatMessage = {
        id: nanoid(8),
        from: self.peerId,
        displayName: self.displayName,
        text: trimmed.slice(0, MAX_CHAT_LENGTH),
        ...(image ? { image } : {}),
        at: Date.now(),
      }
      // We don't receive our own data messages — append locally now.
      setChatMessages((prev) => appendChat(prev, message))
      const payload = new TextEncoder().encode(JSON.stringify(message))
      const opts: DataPublishOptions = { reliable: true, topic: CHAT_TOPIC }
      void room.localParticipant
        .publishData(
          payload as Parameters<typeof room.localParticipant.publishData>[0],
          opts,
        )
        .catch((err) => rtcError('Call', 'chat send failed', err))
    },
    [self],
  )

  const toggleHand = useCallback(() => {
    const raised = !handRaisedRef.current
    handRaisedRef.current = raised
    setHandRaised(raised)
    patch(self.peerId, { handRaised: raised })
    publishHand(raised)
  }, [self, patch, publishHand])

  // ---- Screen share -------------------------------------------------------

  const stopScreenShareInternal = useCallback(async () => {
    const room = roomRef.current
    const videoPub = videoPubRef.current
    if (room && videoPub?.track) {
      if (screenOwnsVideoPubRef.current) {
        // We published the screen as our only video track — remove it entirely.
        await room.localParticipant.unpublishTrack(videoPub.track.mediaStreamTrack)
        videoPubRef.current = null
        screenOwnsVideoPubRef.current = false
      } else {
        // Restore the camera track onto the same publication.
        const cameraTrack = media.managerRef.current?.getCameraVideoTrack() ?? null
        if (cameraTrack) await videoPub.videoTrack?.replaceTrack(cameraTrack)
      }
    }
    media.stopScreenShare()
  }, [media])

  const startScreenShare = useCallback(async () => {
    const room = roomRef.current
    if (!room) return
    try {
      const track = await media.startScreenShare()
      const videoPub = videoPubRef.current
      if (videoPub?.videoTrack) {
        // Swap the screen onto the existing camera publication (Pact parity:
        // remotes see the share in place of the camera tile).
        await videoPub.videoTrack.replaceTrack(track)
      } else {
        // No camera to replace — publish the screen as a new video track.
        videoPubRef.current = await room.localParticipant.publishTrack(track, {
          source: Track.Source.ScreenShare,
        })
        screenOwnsVideoPubRef.current = true
      }
      // Browser "Stop sharing" ends the track → revert.
      track.addEventListener('ended', () => void stopScreenShareInternal())
    } catch (err) {
      rtcError('Call', 'screen share failed', err)
    }
  }, [media, stopScreenShareInternal])

  const switchCamera = useCallback(async () => {
    const newTrack = await media.switchCamera()
    // Don't disturb the video sender while a screen share owns it.
    if (newTrack && !media.mediaState.screenSharing) {
      await videoPubRef.current?.videoTrack?.replaceTrack(newTrack)
    }
  }, [media])

  const toggleNoiseSuppression = useCallback(async () => {
    const newTrack = await media.toggleNoiseSuppression()
    if (newTrack) await audioPubRef.current?.audioTrack?.replaceTrack(newTrack)
  }, [media])

  const toggleBackgroundBlur = useCallback(async () => {
    const newTrack = await media.toggleBackgroundBlur()
    if (newTrack && !media.mediaState.screenSharing) {
      await videoPubRef.current?.videoTrack?.replaceTrack(newTrack)
    }
  }, [media])

  const leaveCall = useCallback(async () => {
    // Null the ref before disconnecting (see the unmount cleanup note).
    const room = roomRef.current
    roomRef.current = null
    room?.disconnect()
    audioPubRef.current = null
    videoPubRef.current = null
    screenOwnsVideoPubRef.current = false
    remoteStreamsRef.current.clear()
    media.stopAll()
    reset()
    router.push('/')
  }, [media, reset, router])

  return {
    participants,
    localStream: media.mediaState.localStream,
    mediaState: media.mediaState,
    callStatus,
    selfPeerId: self.peerId,
    inLobby: callStatus === 'idle',
    roomFull,
    chatMessages,
    sendChat,
    handRaised,
    toggleHand,
    setVisibleParticipants,
    join,
    toggleAudio: media.toggleAudio,
    toggleVideo: media.toggleVideo,
    switchCamera,
    toggleNoiseSuppression,
    toggleBackgroundBlur,
    startScreenShare,
    stopScreenShare: stopScreenShareInternal,
    leaveCall,
  }
}
