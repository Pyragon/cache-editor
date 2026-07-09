import { useEffect, useRef, useState } from 'react'
import type { NativeLibEntry, NativeLibrariesData } from '../loaders/native_libraries'
import { listNativeLibDir } from '../loaders/native_libraries'
import './NativeLibrariesViewer.css'

type Props = {
  data: NativeLibrariesData
}

type Crumb = { name: string; handle: FileSystemDirectoryHandle }

type PendingTarget =
  | { type: 'replace'; handle: FileSystemFileHandle }
  | { type: 'add'; dirHandle: FileSystemDirectoryHandle }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export default function NativeLibrariesViewer({ data }: Props) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ name: 'native_libraries', handle: data.root }])
  const [entries, setEntries] = useState<NativeLibEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingRef = useRef<PendingTarget | null>(null)

  const currentDir = crumbs[crumbs.length - 1].handle

  async function refresh() {
    setIsLoading(true)
    setError(null)
    try {
      const list = await listNativeLibDir(currentDir)
      setEntries(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setEntries([])
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDir])

  function openFolder(entry: Extract<NativeLibEntry, { kind: 'directory' }>) {
    setCrumbs((prev) => [...prev, { name: entry.name, handle: entry.handle }])
  }

  function jumpTo(index: number) {
    setCrumbs((prev) => prev.slice(0, index + 1))
  }

  async function handleDownload(entry: Extract<NativeLibEntry, { kind: 'file' }>) {
    const file = await entry.handle.getFile()
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = entry.name
    a.click()
    URL.revokeObjectURL(url)
  }

  function openReplace(entry: Extract<NativeLibEntry, { kind: 'file' }>) {
    pendingRef.current = { type: 'replace', handle: entry.handle }
    setError(null)
    fileInputRef.current!.value = ''
    fileInputRef.current!.click()
  }

  function openAdd() {
    pendingRef.current = { type: 'add', dirHandle: currentDir }
    setError(null)
    fileInputRef.current!.value = ''
    fileInputRef.current!.click()
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    const pending = pendingRef.current
    if (!file || !pending) return

    setBusyName(pending.type === 'replace' ? pending.handle.name : file.name)
    setError(null)

    try {
      const buffer = await file.arrayBuffer()
      const targetHandle = pending.type === 'replace'
        ? pending.handle
        : await pending.dirHandle.getFileHandle(file.name, { create: true })

      const writable = await targetHandle.createWritable()
      await writable.write(buffer)
      await writable.close()

      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyName(null)
    }
  }

  return (
    <div className="natlib-viewer">
      <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleFileChange} />

      <div className="natlib-toolbar">
        <div className="natlib-breadcrumbs">
          {crumbs.map((crumb, i) => (
            <span key={i} className="natlib-crumb-group">
              {i > 0 && <span className="natlib-crumb-sep">/</span>}
              <button
                type="button"
                className={`natlib-crumb${i === crumbs.length - 1 ? ' current' : ''}`}
                onClick={() => jumpTo(i)}
                disabled={i === crumbs.length - 1}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>
        <button type="button" className="natlib-add-btn" onClick={openAdd}>
          + Add file
        </button>
      </div>

      <div className="natlib-notice">
        Browsers block web pages from listing, downloading, or replacing native library files
        (<code>.dll</code>, <code>.exe</code>, and similar). If a folder here looks empty or a
        file you expect is missing, add, remove, or replace it directly in the unpacked cache
        folder using your file manager instead.
      </div>

      {error && <div className="natlib-error">{error}</div>}

      {isLoading ? (
        <p className="natlib-loading">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="natlib-empty">No files visible here — see note above.</p>
      ) : (
        <div className="natlib-list">
          {entries.map((entry) =>
            entry.kind === 'directory' ? (
              <button
                key={entry.name}
                type="button"
                className="natlib-row natlib-dir"
                onClick={() => openFolder(entry)}
              >
                <span className="natlib-icon">📁</span>
                <span className="natlib-name">{entry.name}</span>
                <span className="natlib-chevron">›</span>
              </button>
            ) : (
              <div key={entry.name} className="natlib-row natlib-file">
                <span className="natlib-icon">📄</span>
                <span className="natlib-name">{entry.name}</span>
                <span className="natlib-size">{formatSize(entry.size)}</span>
                <button
                  type="button"
                  className="natlib-action-btn"
                  disabled={busyName === entry.name}
                  onClick={() => openReplace(entry)}
                >
                  {busyName === entry.name ? 'Working…' : 'Replace'}
                </button>
                <button type="button" className="natlib-action-btn" onClick={() => handleDownload(entry)}>
                  Download
                </button>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
