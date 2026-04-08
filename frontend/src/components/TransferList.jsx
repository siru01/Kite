import styles from './TransferList.module.css'

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export default function TransferList({ transfers, onCancel, onClear }) {
  const handleDownload = (transfer) => {
    if (!transfer.blob) return
    const url = URL.createObjectURL(transfer.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = transfer.name
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>Transfers</h2>
      <div className={styles.list}>
        {[...transfers].reverse().map(t => (
          <div key={t.id} className={`${styles.item} ${t.cancelled ? styles.cancelled : ''}`}>
            <div className={styles.itemHeader}>
              <div className={styles.fileInfo}>
                <span className={styles.dirBadge} data-dir={t.direction}>
                  {t.direction === 'send' ? '↑ Sending' : '↓ Receiving'}
                </span>
                <span className={styles.fileName}>{t.name}</span>
                <span className={styles.fileSize}>{formatBytes(t.size)}</span>
              </div>

              <div className={styles.actions}>
                {/* Download button — only when fully received */}
                {t.done && !t.cancelled && t.direction === 'receive' && t.blob && (
                  <button className={styles.btnDownload} onClick={() => handleDownload(t)}>
                    Save file
                  </button>
                )}

                {/* Cancel button — only while in progress */}
                {!t.done && (
                  <button className={styles.btnCancel} onClick={() => onCancel(t.id)}>
                    Cancel
                  </button>
                )}

                {/* Dismiss button — only when done or cancelled */}
                {t.done && (
                  <button className={styles.btnClear} onClick={() => onClear(t.id)}>✕</button>
                )}
              </div>
            </div>

            {/* Progress bar */}
            <div className={styles.progressTrack}>
              <div
                className={styles.progressBar}
                data-done={t.done}
                data-cancelled={t.cancelled}
                style={{ width: `${t.progress}%` }}
              />
            </div>

            <div className={styles.progressLabel}>
              {t.cancelled
                ? 'Cancelled'
                : t.done
                  ? (t.direction === 'send' ? 'Sent!' : 'Received!')
                  : `${t.progress}%`
              }
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}