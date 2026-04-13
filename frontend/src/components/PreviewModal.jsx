import { useEffect, useState } from 'react'
import styles from './PreviewModal.module.css'

export default function PreviewModal({ file, type, onClose }) {
  const [content, setContent] = useState(null)
  const [loading, setLoading] = useState(type === 'text')

  useEffect(() => {
    if (type === 'text') {
      const reader = new FileReader()
      reader.onload = (e) => {
        setContent(e.target.result)
        setLoading(false)
      }
      reader.onerror = () => setLoading(false)
      reader.readAsText(file.blob)
    }
  }, [file, type])

  const url = URL.createObjectURL(file.blob)

  useEffect(() => {
    return () => URL.revokeObjectURL(url)
  }, [url])

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <header className={styles.header}>
          <div className={styles.titleInfo}>
            <span className={styles.fileName}>{file.name}</span>
            <span className={styles.fileSize}>{(file.size / 1024).toFixed(1)} KB</span>
          </div>
          <button className={styles.btnClose} onClick={onClose}>✕</button>
        </header>

        <div className={styles.content}>
          {loading && <div className={styles.loading}>Loading preview...</div>}
          
          {type === 'image' && <img src={url} alt={file.name} className={styles.previewImage} />}
          
          {type === 'video' && (
            <video src={url} controls autoPlay className={styles.previewVideo}>
              Your browser does not support the video tag.
            </video>
          )}
          
          {type === 'text' && !loading && (
            <pre className={styles.textPreview}>{content}</pre>
          )}
          
          {type === 'pdf' && (
            <iframe src={url} title={file.name} className={styles.previewPdf} />
          )}

          {!type && (
            <div className={styles.unsupported}>
              <div className={styles.icon}>📄</div>
              <p>No preview available for this file type.</p>
              <button className={styles.btnDownload} onClick={() => {
                const a = document.createElement('a')
                a.href = url
                a.download = file.name
                a.click()
              }}>Download to View</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
