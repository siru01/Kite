import { useState } from 'react'
import { useKite } from './useKite'
import PeerList from './components/PeerList'
import TransferList from './components/TransferList'
import styles from './App.module.css'

export default function App() {
  const [inputName, setInputName] = useState('')
  const [joinedAs, setJoinedAs] = useState(null)

  const { myId, peers, status, transfers, sendFile, clearTransfer } = useKite(joinedAs)

  const handleJoin = (e) => {
    e.preventDefault()
    const name = inputName.trim()
    if (name) setJoinedAs(name)
  }

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

  const otherPeers = peers.filter(p => p.id !== myId)

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <span className={styles.logo}>🪁 Kite</span>
        <div className={styles.statusPill} data-status={status}>
          <span className={styles.dot} />
          {status === 'connected' ? `${joinedAs} · ${otherPeers.length} peer${otherPeers.length !== 1 ? 's' : ''} nearby` : status}
        </div>
      </header>

      <main className={styles.main}>
        <PeerList peers={otherPeers} myId={myId} onSendFile={sendFile} />
        {transfers.length > 0 && (
          <TransferList transfers={transfers} onClear={clearTransfer} />
        )}
      </main>
    </div>
  )
}