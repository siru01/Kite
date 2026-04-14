import { useState, useEffect, useRef } from 'react'
import { useKite } from './useKite'
import PeerList from './components/PeerList'
import TransferList from './components/TransferList'
import styles from './App.module.css'

// Unique ID for this tab instance
const TAB_ID = Math.random().toString(36).slice(2)

const AVATARS = Array.from({ length: 11 }, (_, i) => `a${i + 1}`)

export default function App() {
  const [inputName, setInputName] = useState('')
  const [selectedAvatar, setSelectedAvatar] = useState(
    () => sessionStorage.getItem('kite_avatar') || AVATARS[0]
  )
  const [joinedAs, setJoinedAs] = useState(
    () => sessionStorage.getItem('kite_username') || null
  )
  const [tabBlocked, setTabBlocked] = useState(false)
  const channelRef = useRef(null)
  const lastClickRef = useRef(0)

  // ── Single-tab enforcement via BroadcastChannel ───────────────────────────
  useEffect(() => {
    if (!('BroadcastChannel' in window)) return

    const ch = new BroadcastChannel('kite_tab')
    channelRef.current = ch

    ch.onmessage = (e) => {
      const { type, id } = e.data
      if (id === TAB_ID) return

      if (type === 'ping') {
        ch.postMessage({ type: 'pong', id: TAB_ID })
      } else if (type === 'pong') {
        setTabBlocked(true)
      } else if (type === 'takeover') {
        setTabBlocked(true)
      }
    }

    ch.postMessage({ type: 'ping', id: TAB_ID })

    return () => ch.close()
  }, [])

  const { myId, localIp, peers, status, transfers, sendFile, cancelTransfer, clearTransfer } = useKite(joinedAs, selectedAvatar)

  const handleJoin = (e) => {
    e.preventDefault()
    const name = inputName.trim()
    if (name && selectedAvatar) {
      sessionStorage.setItem('kite_username', name)
      sessionStorage.setItem('kite_avatar', selectedAvatar)
      setJoinedAs(name)
    }
  }

  const handleLeave = () => {
    sessionStorage.removeItem('kite_username')
    sessionStorage.removeItem('kite_avatar')
    setJoinedAs(null)
    setInputName('')
    setSelectedAvatar(AVATARS[0])
  }

  const handleTakeover = () => {
    channelRef.current?.postMessage({ type: 'takeover', id: TAB_ID })
    setTabBlocked(false)
  }

  const handleAvatarCycle = () => {
    const currentIndex = AVATARS.indexOf(selectedAvatar)
    const nextIndex = (currentIndex + 1) % AVATARS.length
    setSelectedAvatar(AVATARS[nextIndex])
  }

  const handlePreviewClick = () => {
    const now = Date.now()
    if (now - lastClickRef.current < 300) {
      handleAvatarCycle()
    }
    lastClickRef.current = now
  }

  // ── Join Screen Header (Navbar) ─────────────────────────────────────────
  const navbar = (
    <header className={styles.header}>
      <span className={styles.logo}>KITE</span>
      <div className={styles.headerRight} />
    </header>
  )

  // ── Dashboard Header ─────────────────────────────────────────────────────
  const dashboardNavbar = (
    <header className={styles.dashboardHeader}>
      <span className={styles.logo}>KITE</span>
      <div className={styles.headerCenter}>
        <div className={styles.statusPillCenter} data-status={status}>
          <span className={styles.dot} />
          {status === 'connected' ? `${peers.length} peers nearby` : status}
        </div>
      </div>
      <div className={styles.headerActions}>
        <span className={styles.nameBadge}>{joinedAs}</span>
        <button onClick={handleLeave} className={styles.btnLeaveHeader}>Leave</button>
      </div>
    </header>
  )

  // ── Tab already open in another window ───────────────────────────────────
  if (tabBlocked) {
    return (
      <div className={styles.joinScreen}>
        <div className={styles.joinBg} />
        {navbar}
        <div className={styles.joinCard}>
          <p className={styles.tagline}>Already open in another tab</p>
          <p className={styles.hint}>
            Kite is already running in another tab. Switch back to it,
            or use this tab instead.
          </p>
          <div className={styles.joinForm} style={{ marginTop: '2rem' }}>
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
        <div className={styles.joinBg} />
        {navbar}

        <div className={styles.joinHeadline}>
          <p className={styles.headlineSub}>Send files</p>
          <p className={styles.headlineMain}>FREE &amp; SECURE</p>
        </div>

        <div className={styles.joinCard}>
          {/* Avatar interaction - Scrolling Gallery style */}
          <div className={styles.avatarSection}>
            <div 
              className={styles.avatarPreview}
              onClick={handlePreviewClick}
              title="Double tap to change"
            >
              <div 
                className={styles.avatarGalleryTrack}
                style={{ transform: `translateX(-${AVATARS.indexOf(selectedAvatar) * 100}%)` }}
              >
                {AVATARS.map((av) => (
                  <img
                    key={av}
                    src={`/${av}.jpg`}
                    alt={av}
                    className={styles.avatarGalleryImg}
                  />
                ))}
              </div>
            </div>
          </div>

          <form onSubmit={handleJoin} className={styles.joinForm}>
            <input
              type="text"
              placeholder="Choose your name"
              value={inputName}
              onChange={e => setInputName(e.target.value)}
              maxLength={32}
              autoFocus
            />
            <button
              type="submit"
              className={styles.btnPrimary}
              disabled={!inputName.trim()}
            >
              JOIN
            </button>
          </form>
        </div>
      </div>
    )
  }

  // ── Main Dashboard ────────────────────────────────────────────────────────
  return (
    <div className={styles.app}>
      <div className={styles.joinBg} />
      {dashboardNavbar}

      <div className={styles.dashboardCard}>
        {/* Mobile-only info bar: status pill + name */}
        <div className={styles.mobileInfoBar}>
          <div className={styles.statusPillCenter} data-status={status}>
            <span className={styles.dot} />
            {status === 'connected' ? `${peers.length} peers nearby` : status}
          </div>
          <span className={styles.nameBadge}>{joinedAs}</span>
        </div>

        <div className={styles.dashboardContent}>
          <div className={styles.peerSection}>
            <PeerList peers={peers} myId={myId} localIp={localIp} onSendFile={sendFile} />
          </div>
          {transfers.length > 0 && (
            <div className={styles.transferSection}>
              <TransferList
                transfers={transfers}
                onCancel={cancelTransfer}
                onClear={clearTransfer}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}