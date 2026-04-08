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

export function useKite(myName) {
  const [myId, setMyId] = useState(null)
  const [peers, setPeers] = useState([])
  const [status, setStatus] = useState('disconnected')
  const [transfers, setTransfers] = useState([])

  const wsRef = useRef(null)
  const myIdRef = useRef(null)       // synchronous copy of myId — never stale in filter
  const peerConns = useRef({})       // peerId -> { pc, dc }
  const incomingRef = useRef({})     // peerId -> { id, name, size, chunks[] }
  const cancelledRef = useRef(new Set()) // set of cancelled transferIds

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
            chunks: [],
          }
          addTransfer({
            id: msg.id,
            name: msg.name,
            size: msg.size,
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
            const blob = new Blob(inc.chunks)
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
    let dc
    try { dc = await connectToPeer(targetPeerId) }
    catch (e) { console.error('[sendFile] could not open DC:', e); return }

    const transferId = crypto.randomUUID?.()
      ?? Date.now().toString(36) + Math.random().toString(36).slice(2)

    addTransfer({
      id: transferId,
      name: file.name,
      size: file.size,
      progress: 0,
      direction: 'send',
      done: false,
      cancelled: false,
      blob: null,
    })

    dc.send(JSON.stringify({ type: 'file-meta', id: transferId, name: file.name, size: file.size }))

    let offset = 0
    while (offset < file.size) {
      // Check if cancelled
      if (cancelledRef.current.has(transferId)) {
        dc.send(JSON.stringify({ type: 'file-cancel', id: transferId }))
        return
      }

      // Simple backpressure
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
      await new Promise(r => setTimeout(r, 0)) // yield to UI
    }

    dc.send(JSON.stringify({ type: 'file-end', id: transferId }))
    updateTransfer(transferId, { progress: 100, done: true })
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

  const connectWS = useCallback((name) => {
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    setStatus('connecting')

    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name }))

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
      setTimeout(() => connectWS(name), 3000)
    }

    ws.onerror = () => ws.close()
<<<<<<< HEAD
  }, [handleOffer, handleAnswer, handleIceCandidate])
=======
<<<<<<< HEAD
  }, [])

  const sendSignal = useCallback((target, payload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ ...payload, target }))
    }
  }, [])

  // ── PeerJS init ───────────────────────────────────────────────────────────

  const initPeer = useCallback((id) => {
    // Use PeerJS with public STUN servers
    const peer = new Peer(id, {
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      },
      // Use the signaling server's WebSocket relay for offers/answers
      // by overriding the PeerJS broker with our own (via the ws relay)
    })

    peerRef.current = peer

    peer.on('open', () => {
      // flush any pending signals
      pendingSignals.current.forEach(s => routeSignal(s))
      pendingSignals.current = []
    })

    peer.on('connection', (conn) => {
      setupConn(conn)
    })

    peer.on('error', (err) => {
      console.warn('[PeerJS]', err.type, err.message)
    })
  }, [])

  const routeSignal = (msg) => {
    if (!peerRef.current?.open) {
      pendingSignals.current.push(msg)
      return
    }
    // PeerJS handles signaling internally; this hook is mainly for the
    // peer-list discovery. Actual WebRTC is handled by PeerJS connections.
  }

  // ── DataChannel setup ─────────────────────────────────────────────────────

  const setupConn = useCallback((conn) => {
    openConns.current[conn.peer] = conn

    // Receive side state
    let incoming = null // { id, name, size, chunks }

    conn.on('data', (data) => {
      if (data.type === 'file-meta') {
        // Sender is about to send a file
        incoming = { id: data.id, name: data.name, size: data.size, chunks: [] }
        addTransfer({ id: data.id, name: data.name, size: data.size, progress: 0, direction: 'receive', done: false, blob: null })
        return
      }

      if (data.type === 'file-chunk' && incoming) {
        incoming.chunks.push(data.chunk)
        const received = incoming.chunks.reduce((s, c) => s + c.byteLength, 0)
        const progress = Math.round((received / incoming.size) * 100)
        updateTransfer(incoming.id, { progress })
        return
      }

      if (data.type === 'file-end' && incoming) {
        const blob = new Blob(incoming.chunks)
        updateTransfer(incoming.id, { progress: 100, done: true, blob })
        incoming = null
        return
      }
    })

    conn.on('error', (e) => console.warn('[conn error]', e))
    conn.on('close', () => {
      delete openConns.current[conn.peer]
    })
  }, [])

  // ── Public: send file ─────────────────────────────────────────────────────

  const sendFile = useCallback(async (targetPeerId, file) => {
    const peer = peerRef.current
    if (!peer) return

    let conn = openConns.current[targetPeerId]
    if (!conn || !conn.open) {
      conn = peer.connect(targetPeerId, { reliable: true, serialization: 'binary' })
      openConns.current[targetPeerId] = conn
      await new Promise((res) => conn.on('open', res))
      setupConn(conn) // for the sender side to also receive files back
    }

    const transferId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).substring(2);
    addTransfer({ id: transferId, name: file.name, size: file.size, progress: 0, direction: 'send', done: false, blob: null })

    // Send metadata first
    conn.send({ type: 'file-meta', id: transferId, name: file.name, size: file.size })

    // Read & chunk the file out of storage gradually to prevent OOM
    let offset = 0
    while (offset < file.size) {
      const blobSlice = file.slice(offset, offset + CHUNK_SIZE)
      const chunk = await blobSlice.arrayBuffer()
      conn.send({ type: 'file-chunk', id: transferId, chunk })
      offset += chunk.byteLength
      const progress = Math.round((offset / file.size) * 100)
      updateTransfer(transferId, { progress })
      // Yield to allow UI updates
      await new Promise(r => setTimeout(r, 0))
    }

    conn.send({ type: 'file-end', id: transferId })
    updateTransfer(transferId, { progress: 100, done: true })
  }, [setupConn])

  // ── Public: clear completed ───────────────────────────────────────────────

  const clearTransfer = useCallback((id) => {
    setTransfers(prev => prev.filter(t => t.id !== id))
  }, [])
=======
  }, [handleOffer, handleAnswer, handleIceCandidate])
>>>>>>> 9a1343a (1. use session token to persist connection 2. no duplicate tabs 3. added a cancle button)
>>>>>>> temp-fix

  // ── Mount ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (myName) connectWS(myName)
    return () => {
      wsRef.current?.close()
      Object.values(peerConns.current).forEach(({ pc }) => pc?.close())
    }
  }, [myName])

  // Filter self out using the ref — never stale, never a timing race
  const otherPeers = peers.filter(p => p.id !== myIdRef.current)

  return { myId, peers: otherPeers, status, transfers, sendFile, cancelTransfer, clearTransfer }
}