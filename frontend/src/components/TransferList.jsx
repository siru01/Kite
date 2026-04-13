import { useState, useEffect } from 'react'
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

  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.heading}>Transfers</h2>
        <div className={styles.controls}>
          <button 
            className={styles.btnSecondary} 
            onClick={handleDownloadAll}
            disabled={!transfers.some(t => t.done && t.direction === 'receive' && t.blob && !t.cancelled)}
          >
            Save All (ZIP)
          </button>
        </div>
      </div>
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
                {/* Preview button */}
                {t.done && !t.cancelled && t.blob && getPreviewType(t.mimeType, t.name) && (
                  <button className={styles.btnPreview} onClick={() => setPreviewFile(t)}>
                    Preview
                  </button>
                )}

                {/* Download button — only when fully received */}
                {t.done && !t.cancelled && t.direction === 'receive' && t.blob && (
                  <button className={styles.btnDownload} onClick={() => handleDownload(t)}>
                    Save
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