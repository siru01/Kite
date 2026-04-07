/**
 * useKite — manages:
 *  1. WebSocket connection to the signaling server
 *  2. PeerJS / WebRTC peer connection
 *  3. File send/receive with chunking + progress
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import Peer from 'peerjs'

const CHUNK_SIZE = 64 * 1024 // 64 KB chunks
// const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`      
// Change this to point specifically to your FastAPI port (8000)
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTOCOL}//${window.location.hostname}:8000/ws`;
export function useKite(myName) {
  const [myId, setMyId] = useState(null)
  const [peers, setPeers] = useState([])
  const [status, setStatus] = useState('disconnected') // disconnected | connecting | connected
  const [transfers, setTransfers] = useState([]) // { id, name, size, progress, direction, done, blob }

  const wsRef = useRef(null)
  const peerRef = useRef(null)
  const pendingSignals = useRef([]) // buffer signals that arrive before peer is ready
  const openConns = useRef({}) // peerId -> DataConnection

  // ── helpers ──────────────────────────────────────────────────────────────

  const addTransfer = (t) =>
    setTransfers(prev => [...prev, t])

  const updateTransfer = (id, patch) =>
    setTransfers(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))

  // ── signaling WebSocket ───────────────────────────────────────────────────

  const connectWS = useCallback((name) => {
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    setStatus('connecting')

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', name }))
    }

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)

      switch (msg.type) {
        case 'welcome':
          setMyId(msg.id)
          setStatus('connected')
          initPeer(msg.id)
          break

        case 'peer_list':
          setPeers(msg.peers)
          break

        // WebRTC signaling relay
        case 'offer':
        case 'answer':
        case 'ice-candidate':
          routeSignal(msg)
          break
      }
    }

    ws.onclose = () => {
      setStatus('disconnected')
      setMyId(null)
      setPeers([])
      setTimeout(() => connectWS(name), 3000) // auto-reconnect
    }

    ws.onerror = () => ws.close()
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

  // ── Mount ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (myName) connectWS(myName)
    return () => {
      wsRef.current?.close()
      peerRef.current?.destroy()
    }
  }, [myName])

  return { myId, peers, status, transfers, sendFile, clearTransfer }
}