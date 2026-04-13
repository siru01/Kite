import { useState } from 'react'
import JSZip from 'jszip'
import PreviewModal from './PreviewModal'
import styles from './TransferList.module.css'

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export default function TransferList({ transfers, onCancel, onClear }) {
  const [previewFile, setPreviewFile] = useState(null)

  const handleDownload = (transfer) => {
    if (!transfer.blob) return
    const url = URL.createObjectURL(transfer.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = transfer.name
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleDownloadAll = async () => {
    const received = transfers.filter(t => t.done && t.direction === 'receive' && t.blob && !t.cancelled)
    if (received.length === 0) return

    const zip = new JSZip()
    const nameCounts = {}

    received.forEach(t => {
      let fileName = t.name
      if (nameCounts[fileName]) {
        const dotIndex = fileName.lastIndexOf('.')
        if (dotIndex !== -1) {
          const base = fileName.substring(0, dotIndex)
          const ext = fileName.substring(dotIndex)
          fileName = `${base} (${nameCounts[t.name]})${ext}`
        } else {
          fileName = `${fileName} (${nameCounts[t.name]})`
        }
        nameCounts[t.name]++
      } else {
        nameCounts[fileName] = 1
      }
      zip.file(fileName, t.blob)
    })

    const content = await zip.generateAsync({ type: 'blob' })
    const date = new Date().toISOString().split('T')[0]
    const zipName = `Kite-Transfers-${date}.zip`

    const url = URL.createObjectURL(content)
    const a = document.createElement('a')
    a.href = url
    a.download = zipName
    a.click()
    URL.revokeObjectURL(url)
  }

  const getMimeType = (mimeType, name) => {
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

  const getPreviewType = (mimeType, name) => {
    const type = getMimeType(mimeType, name)
    if (type.startsWith('image/')) return 'image'
    if (type.startsWith('video/')) return 'video'
    if (type.startsWith('text/') || name.match(/\.(txt|js|py|css|html|md|json)$/i)) return 'text'
    if (type === 'application/pdf') return 'pdf'
    return null
  }

  const hasReceived = transfers.some(t => t.done && t.direction === 'receive' && t.blob && !t.cancelled)

  return (
    <section className={styles.section}>
      {/* Header row */}
      <div className={styles.header}>
        <span className={styles.heading}>TRANSFERS</span>
        <button
          className={styles.btnSaveAll}
          onClick={handleDownloadAll}
          disabled={!hasReceived}
        >
          Save All [zip]
        </button>
      </div>

      {/* 2-column grid */}
      <div className={styles.grid}>
        {[...transfers].reverse().map(t => (
          <div key={t.id} className={`${styles.item} ${t.cancelled ? styles.cancelled : ''}`}>
            {/* Progress bar at top of card */}
            {!t.done && (
              <div className={styles.progressTrack}>
                <div
                  className={styles.progressBar}
                  data-done={t.done}
                  data-cancelled={t.cancelled}
                  style={{ width: `${t.progress}%` }}
                />
              </div>
            )}

            <div className={styles.itemRow}>
              {/* File name + size */}
              <div className={styles.fileInfo}>
                <span className={styles.fileName}>{t.name}</span>
                <span className={styles.fileSize}>{formatBytes(t.size)}</span>
              </div>

              {/* Actions */}
              <div className={styles.actions}>
                {/* Preview */}
                {t.done && !t.cancelled && t.blob && getPreviewType(t.mimeType, t.name) && (
                  <button className={styles.btnPreview} onClick={() => setPreviewFile(t)}>
                    preview
                  </button>
                )}

                {/* Save file — only for received */}
                {t.done && !t.cancelled && t.direction === 'receive' && t.blob && (
                  <button className={styles.btnSave} onClick={() => handleDownload(t)}>
                    save file
                  </button>
                )}

                {/* Sending label */}
                {t.direction === 'send' && t.done && !t.cancelled && (
                  <span className={styles.sentLabel}>sent ✓</span>
                )}

                {/* Cancel — in progress */}
                {!t.done && (
                  <button className={styles.btnCancel} onClick={() => onCancel(t.id)}>
                    cancel
                  </button>
                )}

                {/* Dismiss ✕ */}
                {t.done && (
                  <button className={styles.btnDismiss} onClick={() => onClear(t.id)}>✕</button>
                )}
              </div>
            </div>

            {/* Progress label */}
            {!t.done && !t.cancelled && (
              <div className={styles.progressLabel}>{t.progress}%</div>
            )}
            {t.cancelled && (
              <div className={styles.progressLabel}>Cancelled</div>
            )}
          </div>
        ))}
      </div>

      {previewFile && (
        <PreviewModal
          file={previewFile}
          type={getPreviewType(previewFile.mimeType, previewFile.name)}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </section>
  )
}