/**
 * useKite — manages:
 *  1. WebSocket connection to the signaling server
 *  2. Native WebRTC peer connections (signaling via our own WS)
 *  3. File send/receive with chunking + progress + cancellation
 */
import { useEffect, useRef, useState, useCallback } from 'react'

const CHUNK_SIZE = 64 * 1024 // 64 KB chunks

const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const WS_URL = `${WS_PROTOCOL}//${window.location.hostname}:8000/ws`

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

function getMimeType(mimeType, name) {
  if (mimeType) return mimeType
  const ext = name.split('.').pop().toLowerCase()
  const map = {
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp',
    'mp4': 'video/mp4', 'webm': 'video/webm', 'ogg': 'video/ogg',
    'pdf': 'application/pdf',
    'txt': 'text/plain', 'md': 'text/markdown', 'js': 'text/javascript', 'css': 'text/css', 'html': 'text/html'
  }
  return map[ext] || 'application/octet-stream'
}

export function useKite(myName, myAvatar) {
  const [myId, setMyId] = useState(null)
  const [peers, setPeers] = useState([])
  const [status, setStatus] = useState('disconnected')
  const [transfers, setTransfers] = useState([])

  const wsRef = useRef(null)
  const myIdRef = useRef(null)       // synchronous copy of myId — never stale in filter
  const peerConns = useRef({})       // peerId -> { pc, dc }
  const incomingRef = useRef({})     // peerId -> { id, name, size, chunks[] }
  const cancelledRef = useRef(new Set()) // set of cancelled transferIds
  const sendQueues = useRef({})      // peerId -> Promise (sequential queue)

  // ── Transfer state helpers ────────────────────────────────────────────────

  const addTransfer = (t) =>
    setTransfers(prev => [...prev, t])

  const updateTransfer = useCallback((id, patch) =>
    setTransfers(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t)), [])

  // ── WS send helper ────────────────────────────────────────────────────────

  const wsSend = useCallback((msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  // ── Data Channel message handler ──────────────────────────────────────────

  const setupDataChannel = useCallback((dc, peerId) => {
    dc.binaryType = 'arraybuffer'

    dc.onmessage = (e) => {
      const data = e.data

      if (typeof data === 'string') {
        const msg = JSON.parse(data)

        if (msg.type === 'file-meta') {
          incomingRef.current[peerId] = {
            id: msg.id,
            name: msg.name,
            size: msg.size,
            mimeType: msg.mimeType,
            chunks: [],
          }
          addTransfer({
            id: msg.id,
            name: msg.name,
            size: msg.size,
            mimeType: msg.mimeType,
            progress: 0,
            direction: 'receive',
            done: false,
            cancelled: false,
            blob: null,
          })
          return
        }

        if (msg.type === 'file-end') {
          const inc = incomingRef.current[peerId]
          if (inc && inc.id === msg.id) {
            const finalMime = getMimeType(inc.mimeType, inc.name)
            const blob = new Blob(inc.chunks, { type: finalMime })
            updateTransfer(inc.id, { progress: 100, done: true, blob })
            delete incomingRef.current[peerId]
          }
          return
        }

        if (msg.type === 'file-cancel') {
          // The other side cancelled — mark as cancelled here too
          cancelledRef.current.add(msg.id)
          updateTransfer(msg.id, { done: true, cancelled: true })
          const inc = incomingRef.current[peerId]
          if (inc?.id === msg.id) delete incomingRef.current[peerId]
          return
        }

      } else {
        // Binary chunk
        const inc = incomingRef.current[peerId]
        if (inc) {
          // If the user already cancelled this receive, discard it
          if (cancelledRef.current.has(inc.id)) {
            delete incomingRef.current[peerId]
            return
          }
          inc.chunks.push(data)
          const received = inc.chunks.reduce((s, c) => s + c.byteLength, 0)
          updateTransfer(inc.id, { progress: Math.round((received / inc.size) * 100) })
        }
      }
    }

    dc.onerror = (e) => console.warn('[DC error]', peerId, e)
    dc.onclose = () => { delete peerConns.current[peerId] }
  }, [updateTransfer])

  // ── Create RTCPeerConnection ───────────────────────────────────────────────

  const createPc = useCallback((peerId) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        wsSend({ type: 'ice-candidate', target: peerId, candidate: e.candidate })
      }
    }

    pc.ondatachannel = (e) => {
      const dc = e.channel
      if (peerConns.current[peerId]) peerConns.current[peerId].dc = dc
      setupDataChannel(dc, peerId)
    }

    peerConns.current[peerId] = { pc, dc: null }
    return pc
  }, [wsSend, setupDataChannel])

  // ── WebRTC signaling handlers ─────────────────────────────────────────────

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
    setupDataChannel(dc, peerId)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    wsSend({ type: 'offer', target: peerId, offer })

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Connection timed out')), 15000)
      dc.onopen = () => { clearTimeout(t); resolve() }
    })

    return dc
  }, [createPc, setupDataChannel, wsSend])

  // ── Public: send file ─────────────────────────────────────────────────────

  const sendFile = useCallback(async (targetPeerId, file) => {
    const transferId = crypto.randomUUID?.()
      ?? Date.now().toString(36) + Math.random().toString(36).slice(2)

    addTransfer({
      id: transferId,
      name: file.name,
      size: file.size,
      mimeType: file.type,
      progress: 0,
      direction: 'send',
      done: false,
      cancelled: false,
      blob: file, // Keep the file object so the sender can preview it
    })

    // Sequential queue per peer to prevent chunk interleaving
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
          type: 'file-meta', 
          id: transferId, 
          name: file.name, 
          size: file.size, 
          mimeType: file.type 
        }))

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

          const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer()
          dc.send(chunk)
          offset += chunk.byteLength
          updateTransfer(transferId, { progress: Math.round((offset / file.size) * 100) })
          await new Promise(r => setTimeout(r, 0))
        }

        dc.send(JSON.stringify({ type: 'file-end', id: transferId }))
        updateTransfer(transferId, { progress: 100, done: true })
      } catch (err) {
        console.error('[sendFile] internal error:', err)
        updateTransfer(transferId, { done: true, cancelled: true })
      }
    }).catch(err => {
      console.warn('[sendFile] queue error:', err)
    })
  }, [connectToPeer, updateTransfer])

  // ── Public: cancel a transfer ─────────────────────────────────────────────

  const cancelTransfer = useCallback((id) => {
    cancelledRef.current.add(id)
    updateTransfer(id, { done: true, cancelled: true })

    // If we're the receiver, try to notify sender via the open data channel
    Object.values(peerConns.current).forEach(({ dc }) => {
      if (dc?.readyState === 'open') {
        try { dc.send(JSON.stringify({ type: 'file-cancel', id })) } catch (_) {}
      }
    })
  }, [updateTransfer])

  // ── Public: clear a completed transfer ────────────────────────────────────

  const clearTransfer = useCallback((id) => {
    cancelledRef.current.delete(id)
    setTransfers(prev => prev.filter(t => t.id !== id))
  }, [])

  // ── Signaling WebSocket ───────────────────────────────────────────────────

  const connectWS = useCallback((name, avatar) => {
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    setStatus('connecting')

    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name, avatar }))

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      switch (msg.type) {
        case 'welcome':
          myIdRef.current = msg.id   // set ref synchronously — always current
          setMyId(msg.id)
          setStatus('connected')
          break
        case 'peer_list': setPeers(msg.peers); break
        case 'offer':     handleOffer({ from: msg.from, offer: msg.offer }); break
        case 'answer':    handleAnswer({ from: msg.from, answer: msg.answer }); break
        case 'ice-candidate': handleIceCandidate({ from: msg.from, candidate: msg.candidate }); break
      }
    }

    ws.onclose = () => {
      setStatus('disconnected')
      setMyId(null)
      setPeers([])
      setTimeout(() => connectWS(name, avatar), 3000)
    }

    ws.onerror = () => ws.close()
  }, [handleOffer, handleAnswer, handleIceCandidate])

  // ── Mount ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (myName) connectWS(myName, myAvatar)
    return () => {
      wsRef.current?.close()
      Object.values(peerConns.current).forEach(({ pc }) => pc?.close())
    }
  }, [myName, myAvatar])

  // Filter self out using the ref — never stale, never a timing race
  const otherPeers = peers.filter(p => p.id !== myIdRef.current)

  return { myId, peers: otherPeers, status, transfers, sendFile, cancelTransfer, clearTransfer }
}

/* so all chnages aed to the file */