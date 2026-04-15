/**
 * useKite — manages:
 *  1. WebSocket connection to the signaling server
 *  2. Native WebRTC peer connections (signaling via our own WS)
 *  3. File send/receive with chunking + progress + cancellation
 *  4. Transfer speed (MB/s) and time-remaining estimates
 */
import { useEffect, useRef, useState, useCallback } from 'react'

const CHUNK_SIZE = 64 * 1024 // 64 KB

const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const WS_URL = import.meta.env.VITE_WS_URL || `${WS_PROTOCOL}//${window.location.host}/ws`

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

// Backoff config
const BACKOFF_BASE    = 1000
const BACKOFF_MAX     = 30000
const BACKOFF_FACTOR  = 2

// Speed smoothing: rolling window in ms
const SPEED_WINDOW_MS = 2000

function getMimeType(mimeType, name) {
  if (mimeType) return mimeType
  const ext = name.split('.').pop().toLowerCase()
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg',
    pdf: 'application/pdf',
    txt: 'text/plain', md: 'text/markdown',
    js: 'text/javascript', css: 'text/css', html: 'text/html',
  }
  return map[ext] || 'application/octet-stream'
}

/** Rolling-window speed tracker */
function makeSpeedTracker() {
  const samples = [] // { t: timestamp, bytes: cumulative }
  return {
    record(totalBytes) {
      const now = Date.now()
      samples.push({ t: now, bytes: totalBytes })
      // Trim samples older than the window
      const cutoff = now - SPEED_WINDOW_MS
      while (samples.length > 1 && samples[0].t < cutoff) samples.shift()
    },
    /** Returns { speedMBs: number, etaSeconds: number|null } */
    stats(totalBytes, fileSize) {
      if (samples.length < 2) return { speedMBs: 0, etaSeconds: null }
      const oldest = samples[0]
      const newest = samples[samples.length - 1]
      const dt = (newest.t - oldest.t) / 1000 // seconds
      if (dt < 0.05) return { speedMBs: 0, etaSeconds: null }
      const db = newest.bytes - oldest.bytes
      const bytesPerSec = db / dt
      const speedMBs = bytesPerSec / (1024 * 1024)
      const remaining = fileSize - totalBytes
      const etaSeconds = bytesPerSec > 0 ? remaining / bytesPerSec : null
      return { speedMBs, etaSeconds }
    },
  }
}

export function useKite(myName, myAvatar) {
  const [myId, setMyId]         = useState(null)
  const [localIp, setLocalIp]   = useState(null)
  const [serverPort, setServerPort] = useState(null)
  const [peers, setPeers]       = useState([])
  const [status, setStatus]     = useState('disconnected')
  const [transfers, setTransfers] = useState([])

  const wsRef          = useRef(null)
  const myIdRef        = useRef(null)     // sync copy — never stale in closures
  const peerConns      = useRef({})       // peerId -> { pc, dc }
  const incomingRef    = useRef({})       // peerId -> { id, name, size, chunks[], tracker }
  const cancelledRef   = useRef(new Set())
  const sendQueues     = useRef({})       // peerId -> Promise (sequential queue)
  const backoffRef     = useRef(BACKOFF_BASE)
  const reconnTimerRef = useRef(null)
  const unmountedRef   = useRef(false)

  // ── Transfer helpers ──────────────────────────────────────────────────────

  const addTransfer = useCallback((t) =>
    setTransfers(prev => [...prev, t]), [])

  const updateTransfer = useCallback((id, patch) =>
    setTransfers(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t)), [])

  // ── WS send helper ────────────────────────────────────────────────────────

  const wsSend = useCallback((msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  // ── Close stale RTCPeerConnections for peers no longer in the list ────────

  const cleanStalePeerConns = useCallback((currentPeerIds) => {
    const current = new Set(currentPeerIds)
    for (const peerId of Object.keys(peerConns.current)) {
      if (!current.has(peerId)) {
        try {
          peerConns.current[peerId].pc?.close()
        } catch (_) {}
        delete peerConns.current[peerId]
      }
    }
  }, [])

  // ── Data channel message handler ──────────────────────────────────────────

  const setupDataChannel = useCallback((dc, peerId) => {
    dc.binaryType = 'arraybuffer'

    dc.onmessage = (e) => {
      const data = e.data

      if (typeof data === 'string') {
        const msg = JSON.parse(data)

        if (msg.type === 'file-meta') {
          incomingRef.current[peerId] = {
            id:       msg.id,
            name:     msg.name,
            size:     msg.size,
            mimeType: msg.mimeType,
            chunks:   [],
            received: 0,
            tracker:  makeSpeedTracker(),
          }
          addTransfer({
            id:         msg.id,
            name:       msg.name,
            size:       msg.size,
            mimeType:   msg.mimeType,
            progress:   0,
            direction:  'receive',
            done:       false,
            cancelled:  false,
            blob:       null,
            speedMBs:   0,
            etaSeconds: null,
          })
          return
        }

        if (msg.type === 'file-end') {
          const inc = incomingRef.current[peerId]
          if (inc && inc.id === msg.id) {
            const finalMime = getMimeType(inc.mimeType, inc.name)
            const blob = new Blob(inc.chunks, { type: finalMime })
            updateTransfer(inc.id, { progress: 100, done: true, blob, speedMBs: 0, etaSeconds: null })
            delete incomingRef.current[peerId]
          }
          return
        }

        if (msg.type === 'file-cancel') {
          cancelledRef.current.add(msg.id)
          updateTransfer(msg.id, { done: true, cancelled: true })
          const inc = incomingRef.current[peerId]
          if (inc?.id === msg.id) delete incomingRef.current[peerId]
          return
        }

      } else {
        // Binary chunk
        const inc = incomingRef.current[peerId]
        if (!inc) return
        if (cancelledRef.current.has(inc.id)) {
          delete incomingRef.current[peerId]
          return
        }

        inc.chunks.push(data)
        inc.received += data.byteLength
        inc.tracker.record(inc.received)

        const progress = Math.round((inc.received / inc.size) * 100)
        const { speedMBs, etaSeconds } = inc.tracker.stats(inc.received, inc.size)
        updateTransfer(inc.id, { progress, speedMBs, etaSeconds })
      }
    }

    dc.onerror = (e) => console.warn('[DC error]', peerId, e)
    dc.onclose = () => { delete peerConns.current[peerId] }
  }, [addTransfer, updateTransfer])

  // ── Create RTCPeerConnection ───────────────────────────────────────────────

  const createPc = useCallback((peerId) => {
    // Close any existing connection for this peer first
    const existing = peerConns.current[peerId]
    if (existing?.pc) {
      try { existing.pc.close() } catch (_) {}
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    pc.onicecandidate = (e) => {
      if (e.candidate) wsSend({ type: 'ice-candidate', target: peerId, candidate: e.candidate })
    }

    pc.ondatachannel = (e) => {
      const dc = e.channel
      if (peerConns.current[peerId]) peerConns.current[peerId].dc = dc
      setupDataChannel(dc, peerId)
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      if (state === 'failed' || state === 'closed') {
        delete peerConns.current[peerId]
      }
    }

    peerConns.current[peerId] = { pc, dc: null }
    return pc
  }, [wsSend, setupDataChannel])

  // ── WebRTC signaling ──────────────────────────────────────────────────────

  const handleOffer = useCallback(async ({ from, offer }) => {
    const pc = createPc(from)
    await pc.setRemoteDescription(new RTCSessionDescription(offer))
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    wsSend({ type: 'answer', target: from, answer })
  }, [createPc, wsSend])

  const handleAnswer = useCallback(async ({ from, answer }) => {
    const conn = peerConns.current[from]
    if (conn?.pc) await conn.pc.setRemoteDescription(new RTCSessionDescription(answer))
  }, [])

  const handleIceCandidate = useCallback(async ({ from, candidate }) => {
    const conn = peerConns.current[from]
    if (conn?.pc && candidate) {
      try { await conn.pc.addIceCandidate(new RTCIceCandidate(candidate)) }
      catch (e) { console.warn('[ICE]', e) }
    }
  }, [])

  // ── Connect to peer (initiator) ───────────────────────────────────────────

  const connectToPeer = useCallback(async (peerId) => {
    const existing = peerConns.current[peerId]
    if (existing?.dc?.readyState === 'open') return existing.dc

    const pc = createPc(peerId)
    const dc = pc.createDataChannel('kite', { ordered: true })
    peerConns.current[peerId].dc = dc

    // Set up BEFORE the open promise so no messages are missed
    setupDataChannel(dc, peerId)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    wsSend({ type: 'offer', target: peerId, offer })

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Connection timed out')), 15000)
      const origOpen = dc.onopen
      dc.onopen = (e) => {
        clearTimeout(t)
        if (origOpen) origOpen(e)
        resolve()
      }
    })

    return dc
  }, [createPc, setupDataChannel, wsSend])

  // ── Public: send file ─────────────────────────────────────────────────────

  const sendFile = useCallback(async (targetPeerId, file) => {
    const transferId = crypto.randomUUID?.() ??
      (Date.now().toString(36) + Math.random().toString(36).slice(2))

    addTransfer({
      id:         transferId,
      name:       file.name,
      size:       file.size,
      mimeType:   file.type,
      progress:   0,
      direction:  'send',
      done:       false,
      cancelled:  false,
      blob:       file,
      speedMBs:   0,
      etaSeconds: null,
    })

    if (!sendQueues.current[targetPeerId]) {
      sendQueues.current[targetPeerId] = Promise.resolve()
    }

    sendQueues.current[targetPeerId] = sendQueues.current[targetPeerId].then(async () => {
      try {
        if (cancelledRef.current.has(transferId)) return

        let dc
        try {
          dc = await connectToPeer(targetPeerId)
        } catch (e) {
          console.error('[sendFile] could not open DC:', e)
          updateTransfer(transferId, { done: true, cancelled: true })
          return
        }

        dc.send(JSON.stringify({
          type:     'file-meta',
          id:       transferId,
          name:     file.name,
          size:     file.size,
          mimeType: file.type,
        }))

        const tracker = makeSpeedTracker()
        let offset = 0

        while (offset < file.size) {
          if (cancelledRef.current.has(transferId)) {
            dc.send(JSON.stringify({ type: 'file-cancel', id: transferId }))
            return
          }

          // Backpressure: wait if buffer is filling up
          while (dc.bufferedAmount > 1024 * 1024) {
            if (cancelledRef.current.has(transferId)) {
              dc.send(JSON.stringify({ type: 'file-cancel', id: transferId }))
              return
            }
            await new Promise(r => setTimeout(r, 50))
          }

          const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer()
          dc.send(chunk)
          offset += chunk.byteLength

          tracker.record(offset)
          const { speedMBs, etaSeconds } = tracker.stats(offset, file.size)
          updateTransfer(transferId, {
            progress: Math.round((offset / file.size) * 100),
            speedMBs,
            etaSeconds,
          })

          // Yield to the event loop so the UI can update
          await new Promise(r => setTimeout(r, 0))
        }

        dc.send(JSON.stringify({ type: 'file-end', id: transferId }))
        updateTransfer(transferId, { progress: 100, done: true, speedMBs: 0, etaSeconds: null })

      } catch (err) {
        console.error('[sendFile] error:', err)
        updateTransfer(transferId, { done: true, cancelled: true })
      }
    }).catch(err => console.warn('[sendFile] queue error:', err))
  }, [addTransfer, connectToPeer, updateTransfer])

  // ── Public: cancel transfer ───────────────────────────────────────────────

  const cancelTransfer = useCallback((id) => {
    cancelledRef.current.add(id)
    updateTransfer(id, { done: true, cancelled: true })
    Object.values(peerConns.current).forEach(({ dc }) => {
      if (dc?.readyState === 'open') {
        try { dc.send(JSON.stringify({ type: 'file-cancel', id })) } catch (_) {}
      }
    })
  }, [updateTransfer])

  // ── Public: clear completed transfer ─────────────────────────────────────

  const clearTransfer = useCallback((id) => {
    cancelledRef.current.delete(id)
    setTransfers(prev => prev.filter(t => t.id !== id))
  }, [])

  // ── Signaling WebSocket ───────────────────────────────────────────────────

  const connectWS = useCallback((name, avatar) => {
    if (unmountedRef.current) return

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    setStatus('connecting')

    ws.onopen = () => {
      backoffRef.current = BACKOFF_BASE // reset on successful connect
      ws.send(JSON.stringify({
        type:   'join',
        name,
        avatar,
        // Send previously issued ID so the server can reuse it on reconnect
        id: myIdRef.current ?? undefined,
      }))
    }

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      switch (msg.type) {
        case 'welcome':
          myIdRef.current = msg.id
          setMyId(msg.id)
          if (msg.local_ip)  setLocalIp(msg.local_ip)
          if (msg.port)      setServerPort(msg.port)
          setStatus('connected')
          break

        case 'peer_list':
          setPeers(msg.peers)
          // Clean up RTCPeerConnections for peers no longer present
          cleanStalePeerConns(msg.peers.map(p => p.id))
          break

        case 'offer':         handleOffer({ from: msg.from, offer: msg.offer }); break
        case 'answer':        handleAnswer({ from: msg.from, answer: msg.answer }); break
        case 'ice-candidate': handleIceCandidate({ from: msg.from, candidate: msg.candidate }); break

        // Server heartbeat — reply immediately
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }))
          break
      }
    }

    ws.onclose = () => {
      setStatus('disconnected')
      setPeers([])

      if (unmountedRef.current) return

      // Exponential backoff reconnect
      const delay = Math.min(backoffRef.current, BACKOFF_MAX)
      backoffRef.current = Math.min(backoffRef.current * BACKOFF_FACTOR, BACKOFF_MAX)

      reconnTimerRef.current = setTimeout(() => {
        if (!unmountedRef.current) connectWS(name, avatar)
      }, delay)
    }

    ws.onerror = () => ws.close()
  }, [handleOffer, handleAnswer, handleIceCandidate, cleanStalePeerConns])

  // ── Mount / unmount ───────────────────────────────────────────────────────

  useEffect(() => {
    unmountedRef.current = false
    if (myName) connectWS(myName, myAvatar)

    return () => {
      unmountedRef.current = true
      clearTimeout(reconnTimerRef.current)
      wsRef.current?.close()
      Object.values(peerConns.current).forEach(({ pc }) => {
        try { pc?.close() } catch (_) {}
      })
    }
  }, [myName, myAvatar]) // eslint-disable-line react-hooks/exhaustive-deps
  // connectWS is intentionally excluded — it's stable but would cause
  // the effect to re-run on every render if included.

  // Filter self out via ref — never stale, no timing race
  const otherPeers = peers.filter(p => p.id !== myIdRef.current)

  return {
    myId,
    localIp,
    serverPort,
    peers: otherPeers,
    status,
    transfers,
    sendFile,
    cancelTransfer,
    clearTransfer,
  }
}