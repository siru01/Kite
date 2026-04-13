import { useState, useEffect, useRef } from 'react'
import { useKite } from './useKite'
import PeerList from './components/PeerList'
import TransferList from './components/TransferList'
import styles from './App.module.css'

// Unique ID for this tab instance
const TAB_ID = Math.random().toString(36).slice(2)

const AVATARS = Array.from({ length: 11 }, (_, i) => `a${i + 1}`)

const SunIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
  </svg>
)

const MoonIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>
)

export default function App() {
  const [inputName, setInputName] = useState('')
  const [selectedAvatar, setSelectedAvatar] = useState(
    () => sessionStorage.getItem('kite_avatar') || AVATARS[0]
  )
  const [joinedAs, setJoinedAs] = useState(
    () => sessionStorage.getItem('kite_username') || null
  )
  const [theme, setTheme] = useState(
    () => localStorage.getItem('kite_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  )
  const [tabBlocked, setTabBlocked] = useState(false)
  const channelRef = useRef(null)
  const lastClickRef = useRef(0)

  // ── Theme enforcement ──────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('kite_theme', theme)
  }, [theme])

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

  const { myId, peers, status, transfers, sendFile, cancelTransfer, clearTransfer } = useKite(joinedAs)

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

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light')
  }

  // ── Join Screen Header (Navbar) ─────────────────────────────────────────
  const navbar = (
    <header className={styles.header}>
      <span className={styles.logo}>KITE</span>
      <div className={styles.headerRight}>
        <button className={styles.themeToggleNav} onClick={toggleTheme}>
          {theme === 'light' ? <MoonIcon /> : <SunIcon />}
        </button>
      </div>
    </header>
  )

  // ── Dashboard Header ─────────────────────────────────────────────────────
  const dashboardNavbar = (
    <header className={styles.dashboardHeader}>
      <span className={styles.logo}>KITE</span>
      <div className={styles.statusPillCenter} data-status={status}>
        <span className={styles.dot} />
        {joinedAs} &mdash; {status === 'connected' ? `${peers.length} peers nearby` : status}
      </div>
      <button className={styles.themeToggleNav} onClick={toggleTheme}>
        {theme === 'light' ? <MoonIcon /> : <SunIcon />}
      </button>
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
            Kite is already running in another tab or window. Switch back to it,
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
        <PeerList peers={peers} myId={myId} onSendFile={sendFile} />
        {transfers.length > 0 && (
          <TransferList
            transfers={transfers}
            onCancel={cancelTransfer}
            onClear={clearTransfer}
          />
        )}
      </div>

      <button onClick={handleLeave} className={styles.btnLeaveFixed}>Leave</button>
    </div>
  )
}