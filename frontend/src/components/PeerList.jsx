import { useRef, useState } from 'react'
import styles from './PeerList.module.css'

const DEVICE_ICONS = ['💻', '📱', '🖥️', '⌚', '📟']

function getIcon(name) {
  // simple hash to pick a consistent icon per name
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffff
  return DEVICE_ICONS[h % DEVICE_ICONS.length]
}

export default function PeerList({ peers, myId, onSendFile }) {
  const fileInputRef = useRef(null)
  const [targetPeer, setTargetPeer] = useState(null)
  const [draggingOver, setDraggingOver] = useState(null)

  const triggerFilePick = (peer) => {
    setTargetPeer(peer)
    fileInputRef.current?.click()
  }

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files)
    if (files.length && targetPeer) {
      files.forEach(f => onSendFile(targetPeer.id, f))
    }
    e.target.value = ''
    setTargetPeer(null)
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
        <div className={styles.emptyIcon}>📡</div>
        <p className={styles.emptyTitle}>Waiting for devices…</p>
        <p className={styles.emptyHint}>Open Kite on another device on the same Wi-Fi and it will appear here automatically.</p>
      </div>
    )
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>Nearby devices</h2>
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
            <div className={styles.icon}>{getIcon(peer.name)}</div>
            <div className={styles.peerName}>{peer.name}</div>
            <div className={styles.peerAction}>
              {draggingOver === peer.id ? 'Drop to send' : 'Click or drop files'}
            </div>
          </div>
        ))}
      </div>

      {/* Hidden file input */}
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