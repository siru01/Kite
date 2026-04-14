import { useRef, useState } from 'react'
import styles from './PeerList.module.css'

export default function PeerList({ peers, myId, localIp, onSendFile }) {
  const fileInputRef = useRef(null)
  const targetPeerRef = useRef(null)
  const [draggingOver, setDraggingOver] = useState(null)

  const triggerFilePick = (peer) => {
    targetPeerRef.current = peer
    fileInputRef.current?.click()
  }

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files)
    if (files.length && targetPeerRef.current) {
      files.forEach(f => onSendFile(targetPeerRef.current.id, f))
    }
    e.target.value = ''
    targetPeerRef.current = null
  }

  const handleDrop = (e, peer) => {
    e.preventDefault()
    setDraggingOver(null)
    const files = Array.from(e.dataTransfer.files)
    files.forEach(f => onSendFile(peer.id, f))
  }

  if (peers.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.broadcastIcon}>
          <svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" className={styles.broadcastSvg}>
            <path className={styles.wave3} d="M14 40c0-14.36 11.64-26 26-26s26 11.64 26 26-11.64 26-26 26" stroke="#1a1a1a" strokeWidth="3" strokeLinecap="round" fill="none"/>
            <path className={styles.wave3} d="M66 40c0 14.36-11.64 26-26 26" stroke="#1a1a1a" strokeWidth="3" strokeLinecap="round" fill="none"/>
            <path className={styles.wave2} d="M22 40c0-9.94 8.06-18 18-18s18 8.06 18 18-8.06 18-18 18" stroke="#1a1a1a" strokeWidth="3" strokeLinecap="round" fill="none"/>
            <path className={styles.wave2} d="M58 40c0 9.94-8.06 18-18 18" stroke="#1a1a1a" strokeWidth="3" strokeLinecap="round" fill="none"/>
            <path className={styles.wave1} d="M30 40c0-5.52 4.48-10 10-10s10 4.48 10 10-4.48 10-10 10" stroke="#1a1a1a" strokeWidth="3" strokeLinecap="round" fill="none"/>
            <path className={styles.wave1} d="M50 40c0 5.52-4.48 10-10 10" stroke="#1a1a1a" strokeWidth="3" strokeLinecap="round" fill="none"/>
            <circle cx="40" cy="40" r="4" fill="#1a1a1a"/>
            <line x1="40" y1="44" x2="40" y2="64" stroke="#1a1a1a" strokeWidth="3" strokeLinecap="round"/>
          </svg>
        </div>
        <p className={styles.emptyTitle}>Waiting for devices...</p>
        <p className={styles.emptyHint}>Open Kite on another device on the same Wi-Fi and it will appear here automatically.</p>
        
        {localIp && (
          <div className={styles.localLinkContainer}>
            <p className={styles.localLinkText}>go this link in your browser to connect</p>
            <p className={styles.localLinkUrl}>
              {window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
                ? `http://${localIp}:5173/` 
                : window.location.origin}
            </p>
          </div>
        )}
      </div>
    )
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.pageTitle}>Devices in the Network</h2>
      <div className={styles.grid}>
        {peers.map(peer => (
          <div
            key={peer.id}
            className={`${styles.peerCard} ${draggingOver === peer.id ? styles.dragOver : ''}`}
            onDragOver={e => { e.preventDefault(); setDraggingOver(peer.id) }}
            onDragLeave={() => setDraggingOver(null)}
            onDrop={e => handleDrop(e, peer)}
            onClick={() => triggerFilePick(peer)}
            title="Click to send a file, or drag & drop"
          >
            <div className={styles.cardInner}>
              <img
                src={`/${peer.avatar || 'a1'}.jpg`}
                alt={peer.name}
                className={styles.peerAvatar}
                style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover' }}
              />
              <span className={styles.peerAction}>
                {draggingOver === peer.id ? 'drop to send' : 'click or drop files'}
              </span>
            </div>
            <div className={styles.peerName}>{peer.name}</div>
          </div>
        ))}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </section>
  )
}