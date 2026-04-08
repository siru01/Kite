import { useState, useEffect, useRef } from 'react'
import { useKite } from './useKite'
import PeerList from './components/PeerList'
import TransferList from './components/TransferList'
import styles from './App.module.css'

// Unique ID for this tab instance
const TAB_ID = Math.random().toString(36).slice(2)

export default function App() {
  const [inputName, setInputName] = useState('')
  const [joinedAs, setJoinedAs] = useState(
    () => sessionStorage.getItem('kite_username') || null  // persists on reload, clears on tab close
  )
  const [tabBlocked, setTabBlocked] = useState(false)
  const channelRef = useRef(null)

  // ── Single-tab enforcement via BroadcastChannel ───────────────────────────
  useEffect(() => {
    if (!('BroadcastChannel' in window)) return

    const ch = new BroadcastChannel('kite_tab')
    channelRef.current = ch

    ch.onmessage = (e) => {
      const { type, id } = e.data
      if (id === TAB_ID) return // ignore our own messages

      if (type === 'ping') {
        // Another tab just opened — let it know we exist
        ch.postMessage({ type: 'pong', id: TAB_ID })
      } else if (type === 'pong') {
        // An existing tab replied to our ping — we're a duplicate
        setTabBlocked(true)
      } else if (type === 'takeover') {
        // The user chose to use a new tab — we yield
        setTabBlocked(true)
      }
    }

    // Ask if any other tab is open
    ch.postMessage({ type: 'ping', id: TAB_ID })

    return () => ch.close()
  }, [])

  const { myId, peers, status, transfers, sendFile, cancelTransfer, clearTransfer } = useKite(joinedAs)

  const handleJoin = (e) => {
    e.preventDefault()
    const name = inputName.trim()
    if (name) {
      sessionStorage.setItem('kite_username', name)
      setJoinedAs(name)
    }
  }

  const handleLeave = () => {
    sessionStorage.removeItem('kite_username')
    setJoinedAs(null)
    setInputName('')
  }

  const handleTakeover = () => {
    channelRef.current?.postMessage({ type: 'takeover', id: TAB_ID })
    setTabBlocked(false)
  }

  // ── Tab already open in another window ───────────────────────────────────
  if (tabBlocked) {
    return (
      <div className={styles.joinScreen}>
        <div className={styles.joinCard}>
          <div className={styles.logo}>🪁 Kite</div>
          <p className={styles.tagline}>Already open in another tab</p>
          <p className={styles.hint}>
            Kite is already running in another tab or window. Switch back to it,
            or use this tab instead.
          </p>
          <div className={styles.joinForm} style={{ marginTop: '1.25rem' }}>
            <button className={styles.btnPrimary} onClick={handleTakeover}>
              Use This Tab
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Join screen ───────────────────────────────────────────────────────────
  if (!joinedAs) {
    return (
      <div className={styles.joinScreen}>
        <div className={styles.joinCard}>
          <div className={styles.logo}>🪁 Kite</div>
          <p className={styles.tagline}>Local file sharing. No cloud. No cables.</p>
          <form onSubmit={handleJoin} className={styles.joinForm}>
            <input
              type="text"
              placeholder="Your device name (e.g. Rahul's Laptop)"
              value={inputName}
              onChange={e => setInputName(e.target.value)}
              maxLength={32}
              autoFocus
            />
            <button type="submit" className={styles.btnPrimary} disabled={!inputName.trim()}>
              Join Network
            </button>
          </form>
          <p className={styles.hint}>Other devices on your Wi-Fi will see you automatically.</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <span className={styles.logo}>🪁 Kite</span>
        <div className={styles.statusPill} data-status={status}>
          <span className={styles.dot} />
          {status === 'connected'
            ? `${joinedAs} · ${peers.length} peer${peers.length !== 1 ? 's' : ''} nearby`
            : status}
        </div>
        <button onClick={handleLeave} className={styles.btnLeave}>Leave</button>
      </header>

      <main className={styles.main}>
        <PeerList peers={peers} myId={myId} onSendFile={sendFile} />
        {transfers.length > 0 && (
          <TransferList
            transfers={transfers}
            onCancel={cancelTransfer}
            onClear={clearTransfer}
          />
        )}
      </main>
    </div>
  )
}