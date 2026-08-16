/**
 * useKite — manages:
 *  1. WebSocket connection to the signaling server
 *  2. Native WebRTC peer connections (signaling via our own WS)
 *  3. E2EE File send/receive with AES-256-GCM + SHA-256 verification + 2-step consent handshake
 *  4. Transfer speed (MB/s) and time-remaining estimates
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  generateSessionKey,
  exportRawKey,
  importRawKey,
  generateIV,
  encryptChunk,
  decryptChunk,
  computeFileSHA256,
  sanitizeFilename,
  isExecutableFilename,
} from './cryptoUtils'

const CHUNK_SIZE = 64 * 1024 // 64 KB (Ensures encrypted payload + 12B IV + 16B GCM tag fits well within WebRTC SCTP maxMessageSize limit)

const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const defaultHost = window.location.port === '5173'
  ? `${window.location.hostname}:8000`
  : window.location.host
const WS_URL = import.meta.env.VITE_WS_URL || `${WS_PROTOCOL}//${defaultHost}/ws`

let defaultIceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

if (import.meta.env && import.meta.env.VITE_ICE_SERVERS) {
  try {
    defaultIceServers = JSON.parse(import.meta.env.VITE_ICE_SERVERS)
  } catch (e) {
    console.error('Failed to parse VITE_ICE_SERVERS:', e)
  }
}

const ICE_SERVERS = defaultIceServers

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
      const cutoff = now - SPEED_WINDOW_MS
      while (samples.length > 1 && samples[0].t < cutoff) samples.shift()
    },
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

  const wsRef               = useRef(null)
  const myIdRef             = useRef(null)     // sync copy
  const peerConns           = useRef({})       // peerId -> { pc, dc }
  const incomingRef         = useRef({})       // peerId -> { id, name, size, mimeType, hash, key, chunks[], tracker }
  const pendingOffersRef    = useRef({})       // transferId -> { peerId, meta, key }
  const handshakesRef       = useRef({})       // transferId -> { resolve, reject }
  const cancelledRef        = useRef(new Set())
  const sendQueues          = useRef({})       // peerId -> Promise (sequential queue)
  const backoffRef          = useRef(BACKOFF_BASE)
  const reconnTimerRef      = useRef(null)
  const unmountedRef        = useRef(false)
  const iceServersRef       = useRef(ICE_SERVERS)
  const earlyIceCandidates  = useRef({}) // peerId -> candidate[]

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

  // ── Close stale RTCPeerConnections ────────────────────────────────────────

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

  // ── Accept & Decline Transfers ────────────────────────────────────────────

  const acceptTransfer = useCallback((transferId) => {
    const offer = pendingOffersRef.current[transferId]
    if (!offer) return

    const { peerId, meta, key } = offer
    incomingRef.current[peerId] = {
      id:       meta.id,
      name:     meta.name,
      size:     meta.size,
      mimeType: meta.mimeType,
      hash:     meta.hash,
      key:      key,
      chunks:   [],
      received: 0,
      tracker:  makeSpeedTracker(),
    }

    updateTransfer(transferId, { status: 'receiving', pendingConsent: false })

    const conn = peerConns.current[peerId]
    if (conn?.dc?.readyState === 'open') {
      conn.dc.send(JSON.stringify({ type: 'file-accept', id: transferId }))
    }

    delete pendingOffersRef.current[transferId]
  }, [updateTransfer])

  const declineTransfer = useCallback((transferId) => {
    const offer = pendingOffersRef.current[transferId]
    if (offer) {
      const conn = peerConns.current[offer.peerId]
      if (conn?.dc?.readyState === 'open') {
        try { conn.dc.send(JSON.stringify({ type: 'file-decline', id: transferId })) } catch (_) {}
      }
      delete pendingOffersRef.current[transferId]
    }
    cancelledRef.current.add(transferId)
    updateTransfer(transferId, { done: true, cancelled: true, error: 'Declined', pendingConsent: false })
  }, [updateTransfer])

  // ── Data channel message handler ──────────────────────────────────────────

  const setupDataChannel = useCallback((dc, peerId) => {
    dc.binaryType = 'arraybuffer'

    dc.onmessage = async (e) => {
      const data = e.data

      if (typeof data === 'string') {
        const msg = JSON.parse(data)

        // 1. Handshake offer received
        if (msg.type === 'file-offer' || msg.type === 'file-meta') {
          const cleanName = sanitizeFilename(msg.name)
          const isExe = isExecutableFilename(cleanName)
          let sessionKey = null

          if (msg.key) {
            try {
              sessionKey = await importRawKey(msg.key)
            } catch (err) {
              console.error('[setupDataChannel] Error importing E2EE session key:', err)
            }
          }

          pendingOffersRef.current[msg.id] = {
            peerId,
            meta: { ...msg, name: cleanName },
            key: sessionKey
          }

          addTransfer({
            id:             msg.id,
            name:           cleanName,
            size:           msg.size,
            mimeType:       msg.mimeType,
            hash:           msg.hash,
            isExecutable:   isExe,
            e2ee:           !!msg.key,
            pendingConsent: true,
            progress:       0,
            direction:      'receive',
            done:           false,
            cancelled:      false,
            blob:           null,
            speedMBs:       0,
            etaSeconds:     null,
          })
          return
        }

        // 2. Sender received acceptance from receiver
        if (msg.type === 'file-accept') {
          if (handshakesRef.current[msg.id]) {
            handshakesRef.current[msg.id].resolve(true)
            delete handshakesRef.current[msg.id]
          }
          return
        }

        // 3. Sender received decline from receiver
        if (msg.type === 'file-decline') {
          if (handshakesRef.current[msg.id]) {
            handshakesRef.current[msg.id].resolve(false)
            delete handshakesRef.current[msg.id]
          }
          return
        }

        // 4. File transfer finished -> compute SHA-256 integrity hash
        if (msg.type === 'file-end') {
          const inc = incomingRef.current[peerId]
          if (inc && inc.id === msg.id) {
            try {
              const finalMime = getMimeType(inc.mimeType, inc.name)
              const blob = new Blob(inc.chunks, { type: finalMime })

              // Verify master SHA-256 file checksum if provided
              if (inc.hash) {
                const computedHash = await computeFileSHA256(blob)
                if (computedHash !== inc.hash) {
                  updateTransfer(inc.id, {
                    done: true,
                    cancelled: true,
                    error: 'Integrity verification failed (SHA-256 checksum mismatch)',
                    speedMBs: 0,
                    etaSeconds: null
                  })
                  delete incomingRef.current[peerId]
                  return
                }
              }

              updateTransfer(inc.id, {
                progress: 100,
                done: true,
                verified: true,
                blob,
                speedMBs: 0,
                etaSeconds: null
              })
            } catch (err) {
              console.error('[file-end] Error processing file:', err)
              updateTransfer(inc.id, { done: true, cancelled: true, error: 'File assembly failed' })
            } finally {
              delete incomingRef.current[peerId]
            }
          }
          return
        }

        // 5. Transfer cancelled
        if (msg.type === 'file-cancel') {
          cancelledRef.current.add(msg.id)
          updateTransfer(msg.id, { done: true, cancelled: true })
          const inc = incomingRef.current[peerId]
          if (inc?.id === msg.id) delete incomingRef.current[peerId]
          delete pendingOffersRef.current[msg.id]
          return
        }

      } else {
        // Binary encrypted chunk (12-byte IV + encrypted AES-256 payload)
        const inc = incomingRef.current[peerId]
        if (!inc) return
        if (cancelledRef.current.has(inc.id)) {
          delete incomingRef.current[peerId]
          return
        }

        try {
          let chunkData = data
          if (inc.key && data.byteLength > 12) {
            const iv = new Uint8Array(data, 0, 12)
            const encryptedPayload = data.slice(12)
            chunkData = await decryptChunk(encryptedPayload, inc.key, iv)
          }

          inc.chunks.push(chunkData)
          inc.received += chunkData.byteLength
          inc.tracker.record(inc.received)

          const progress = Math.round((inc.received / inc.size) * 100)
          const { speedMBs, etaSeconds } = inc.tracker.stats(inc.received, inc.size)
          updateTransfer(inc.id, { progress, speedMBs, etaSeconds })
        } catch (err) {
          console.error('[DC binary] Chunk decryption / processing error:', err)
          updateTransfer(inc.id, { done: true, cancelled: true, error: 'Chunk decryption failed' })
          delete incomingRef.current[peerId]
        }
      }
    }

    dc.onerror = (e) => {
      console.warn('[DC error]', peerId, e)
      const inc = incomingRef.current[peerId]
      if (inc) {
        updateTransfer(inc.id, { done: true, cancelled: true, error: 'Data channel error' })
        delete incomingRef.current[peerId]
      }
    }

    dc.onclose = () => {
      delete peerConns.current[peerId]
      const inc = incomingRef.current[peerId]
      if (inc) {
        updateTransfer(inc.id, { done: true, cancelled: true, error: 'Connection closed' })
        delete incomingRef.current[peerId]
      }
    }
  }, [addTransfer, updateTransfer])

  // ── Create RTCPeerConnection ───────────────────────────────────────────────

  const createPc = useCallback((peerId) => {
    const existing = peerConns.current[peerId]
    if (existing?.pc) {
      try { existing.pc.close() } catch (_) {}
    }

    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current })

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
        const inc = incomingRef.current[peerId]
        if (inc) {
          updateTransfer(inc.id, { done: true, cancelled: true, error: `Connection ${state}` })
          delete incomingRef.current[peerId]
        }
        delete peerConns.current[peerId]
      }
    }

    const iceQueue = earlyIceCandidates.current[peerId] || []
    delete earlyIceCandidates.current[peerId]

    peerConns.current[peerId] = { pc, dc: null, iceQueue }
    return pc
  }, [wsSend, setupDataChannel, updateTransfer])

  // ── WebRTC signaling ──────────────────────────────────────────────────────

  const handleOffer = useCallback(async ({ from, offer }) => {
    const pc = createPc(from)
    await pc.setRemoteDescription(new RTCSessionDescription(offer))
    
    const conn = peerConns.current[from]
    if (conn?.iceQueue) {
      for (const cand of conn.iceQueue) {
        try { await pc.addIceCandidate(new RTCIceCandidate(cand)) }
        catch (e) { console.warn('[ICE queued]', e) }
      }
      conn.iceQueue = []
    }

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    wsSend({ type: 'answer', target: from, answer })
  }, [createPc, wsSend])

  const handleAnswer = useCallback(async ({ from, answer }) => {
    const conn = peerConns.current[from]
    if (conn?.pc) {
      await conn.pc.setRemoteDescription(new RTCSessionDescription(answer))
      if (conn.iceQueue) {
        for (const cand of conn.iceQueue) {
          try { await conn.pc.addIceCandidate(new RTCIceCandidate(cand)) }
          catch (e) { console.warn('[ICE queued]', e) }
        }
        conn.iceQueue = []
      }
    }
  }, [])

  const handleIceCandidate = useCallback(async ({ from, candidate }) => {
    if (!candidate) return

    const conn = peerConns.current[from]
    if (!conn?.pc) {
      if (!earlyIceCandidates.current[from]) {
        earlyIceCandidates.current[from] = []
      }
      earlyIceCandidates.current[from].push(candidate)
      return
    }

    if (!conn.pc.remoteDescription) {
      if (!conn.iceQueue) conn.iceQueue = []
      conn.iceQueue.push(candidate)
      return
    }

    try {
      await conn.pc.addIceCandidate(new RTCIceCandidate(candidate))
    } catch (e) {
      console.warn('[Kite] ICE Error adding candidate:', e)
    }
  }, [])

  // ── Connect to peer ───────────────────────────────────────────────────────

  const connectToPeer = useCallback(async (peerId) => {
    const existing = peerConns.current[peerId]
    if (existing?.dc?.readyState === 'open') return existing.dc

    const pc = createPc(peerId)
    const dc = pc.createDataChannel('kite', { ordered: true })
    peerConns.current[peerId].dc = dc

    setupDataChannel(dc, peerId)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    wsSend({ type: 'offer', target: peerId, offer })

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const iceState = pc.iceConnectionState
        reject(new Error(`Connection timed out (ICE state: ${iceState}). Check network.`))
      }, 30000)

      const cleanup = () => {
        clearTimeout(t)
        pc.oniceconnectionstatechange = null
      }

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState
        if (state === 'failed') {
          cleanup()
          reject(new Error('ICE connection failed.'))
        }
      }

      const origOpen = dc.onopen
      dc.onopen = (e) => {
        cleanup()
        if (origOpen) origOpen(e)
        resolve()
      }
    })

    return dc
  }, [createPc, setupDataChannel, wsSend])

  // ── Public: send file (E2EE + Handshake + SHA-256) ─────────────────────────

  const sendFile = useCallback(async (targetPeerId, file) => {
    const transferId = crypto.randomUUID?.() ??
      (Date.now().toString(36) + Math.random().toString(36).slice(2))

    const cleanName = sanitizeFilename(file.name)
    const isExe = isExecutableFilename(cleanName)

    addTransfer({
      id:             transferId,
      name:           cleanName,
      size:           file.size,
      mimeType:       file.type,
      isExecutable:   isExe,
      e2ee:           true,
      status:         'hashing',
      progress:       0,
      direction:      'send',
      done:           false,
      cancelled:      false,
      blob:           file,
      speedMBs:       0,
      etaSeconds:     null,
    })

    if (!sendQueues.current[targetPeerId]) {
      sendQueues.current[targetPeerId] = Promise.resolve()
    }

    sendQueues.current[targetPeerId] = sendQueues.current[targetPeerId].then(async () => {
      try {
        if (cancelledRef.current.has(transferId)) return

        // 1. Compute SHA-256 master hash & generate AES-256-GCM session key
        const masterHash = await computeFileSHA256(file)
        const sessionKey = await generateSessionKey()
        const exportedKeyBase64 = await exportRawKey(sessionKey)

        if (cancelledRef.current.has(transferId)) return
        updateTransfer(transferId, { hash: masterHash, status: 'connecting' })

        let dc
        try {
          dc = await connectToPeer(targetPeerId)
        } catch (e) {
          console.error('[sendFile] could not open DC:', e)
          updateTransfer(transferId, { done: true, cancelled: true, error: e.message || String(e) })
          return
        }

        // 2. Send 2-step handshake file-offer to receiver
        updateTransfer(transferId, { status: 'waiting_consent' })

        const acceptedPromise = new Promise((resolve) => {
          handshakesRef.current[transferId] = { resolve }
          setTimeout(() => {
            if (handshakesRef.current[transferId]) {
              delete handshakesRef.current[transferId]
              resolve(false)
            }
          }, 120000) // 2 minute timeout for peer consent
        })

        dc.send(JSON.stringify({
          type:         'file-offer',
          id:           transferId,
          name:         cleanName,
          size:         file.size,
          mimeType:     file.type,
          hash:         masterHash,
          key:          exportedKeyBase64,
          isExecutable: isExe,
        }))

        const accepted = await acceptedPromise

        if (!accepted || cancelledRef.current.has(transferId)) {
          updateTransfer(transferId, { done: true, cancelled: true, error: 'Declined or timed out by recipient' })
          return
        }

        updateTransfer(transferId, { status: 'sending' })

        // 3. Encrypt & stream binary chunks
        const tracker = makeSpeedTracker()
        let offset = 0

        while (offset < file.size) {
          if (cancelledRef.current.has(transferId)) {
            dc.send(JSON.stringify({ type: 'file-cancel', id: transferId }))
            return
          }

          while (dc.bufferedAmount > 1024 * 1024) {
            if (cancelledRef.current.has(transferId)) {
              dc.send(JSON.stringify({ type: 'file-cancel', id: transferId }))
              return
            }
            await new Promise(r => setTimeout(r, 50))
          }

          const rawChunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer()
          const iv = generateIV() // 12-byte IV for AES-GCM
          const encryptedChunk = await encryptChunk(rawChunk, sessionKey, iv)

          // Packet format: [12-byte IV][Encrypted AES-GCM Payload]
          const packet = new Uint8Array(12 + encryptedChunk.byteLength)
          packet.set(iv, 0)
          packet.set(new Uint8Array(encryptedChunk), 12)

          dc.send(packet.buffer)
          offset += rawChunk.byteLength

          tracker.record(offset)
          const { speedMBs, etaSeconds } = tracker.stats(offset, file.size)
          updateTransfer(transferId, {
            progress: Math.round((offset / file.size) * 100),
            speedMBs,
            etaSeconds,
          })

          await new Promise(r => setTimeout(r, 0))
        }

        dc.send(JSON.stringify({ type: 'file-end', id: transferId }))
        updateTransfer(transferId, { progress: 100, done: true, speedMBs: 0, etaSeconds: null })

      } catch (err) {
        console.error('[sendFile] error:', err)
        updateTransfer(transferId, { done: true, cancelled: true, error: err.message || String(err) })
      }
    }).catch(err => console.warn('[sendFile] queue error:', err))
  }, [addTransfer, connectToPeer, updateTransfer])

  // ── Public: cancel transfer ───────────────────────────────────────────────

  const cancelTransfer = useCallback((id) => {
    cancelledRef.current.add(id)
    if (handshakesRef.current[id]) {
      handshakesRef.current[id].resolve(false)
      delete handshakesRef.current[id]
    }
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
    delete pendingOffersRef.current[id]
    setTransfers(prev => prev.filter(t => t.id !== id))
  }, [])

  // ── Signaling WebSocket ───────────────────────────────────────────────────

  const connectWS = useCallback((name, avatar) => {
    if (unmountedRef.current) return

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    setStatus('connecting')

    ws.onopen = () => {
      backoffRef.current = BACKOFF_BASE
      ws.send(JSON.stringify({
        type:   'join',
        name,
        avatar,
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
          if (msg.ice_servers) iceServersRef.current = msg.ice_servers
          setStatus('connected')
          break

        case 'peer_list':
          setPeers(msg.peers)
          cleanStalePeerConns(msg.peers.map(p => p.id))
          break

        case 'offer':         handleOffer({ from: msg.from, offer: msg.offer }); break
        case 'answer':        handleAnswer({ from: msg.from, answer: msg.answer }); break
        case 'ice-candidate': handleIceCandidate({ from: msg.from, candidate: msg.candidate }); break

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }))
          break
      }
    }

    ws.onclose = () => {
      setStatus('disconnected')
      setPeers([])
      if (unmountedRef.current) return

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
  }, [myName, myAvatar])

  const otherPeers = peers.filter(p => p.id !== myIdRef.current)

  return {
    myId,
    localIp,
    serverPort,
    peers: otherPeers,
    status,
    transfers,
    sendFile,
    acceptTransfer,
    declineTransfer,
    cancelTransfer,
    clearTransfer,
  }
}