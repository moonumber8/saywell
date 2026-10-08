import { useEffect, useState } from 'react'

type Source = { id: string; title: string; level: string; pageStart?: number; pageEnd?: number; filename?: string; characters?: number }
type FullSource = Source & { content: string; format?: string }

export default function CurriculumPreview({ documents, selectedId }: { documents: Source[]; selectedId: string }) {
  const [open, setOpen] = useState(false)
  const [previewId, setPreviewId] = useState('')
  const [document, setDocument] = useState<FullSource | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !previewId) return
    const controller = new AbortController()
    fetch(`/api/curriculum/documents/${encodeURIComponent(previewId)}`, { signal: controller.signal }).then(async (response) => {
      const source = await response.json()
      if (!response.ok) throw new Error(source.error)
      setDocument(source)
    }).catch((caught) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'โหลดพรีวิวไม่ได้') })
    return () => controller.abort()
  }, [open, previewId])

  function select(id: string) {
    setPreviewId(id)
    setError('')
  }

  function toggle() {
    if (!open) select(selectedId || documents[0]?.id || '')
    setOpen(!open)
  }

  if (!documents.length) return null

  return <section className="curriculum-preview" aria-label="พรีวิวหลักสูตรที่นำเข้า">
    <button className="example-button" type="button" aria-expanded={open} aria-controls="curriculum-preview-content" onClick={toggle}>{open ? 'ปิดพรีวิวหลักสูตร' : `พรีวิวเนื้อหาที่นำเข้า (${documents.length} ส่วน)`}</button>
    {open && <div id="curriculum-preview-content">
      <p>ดูข้อความเต็มที่บันทึกไว้โดยไม่เรียก AI หมายเลขหน้าอ้างอิงลำดับหน้าในไฟล์ PDF รูปภาพและแผนภาพไม่ได้รวมอยู่ในพรีวิวข้อความ</p>
      <div className="curriculum-preview-grid">
        <nav className="curriculum-preview-list" aria-label="สารบัญหลักสูตร">{documents.map((source) => <button type="button" key={source.id} aria-pressed={source.id === previewId} onClick={() => select(source.id)}><strong>{source.title}</strong><small>{source.level}{source.pageStart ? ` · หน้า ${source.pageStart}–${source.pageEnd}` : ''}</small></button>)}</nav>
        <article className="curriculum-preview-text" aria-live="polite">
          {error ? <p role="alert">{error}</p> : document?.id === previewId ? <>
            <h2>{document.title}</h2>
            <p>{document.filename || 'หลักสูตรที่เพิ่มเอง'}{document.pageStart ? ` · หน้า ${document.pageStart}–${document.pageEnd}` : ''} · {document.content.length.toLocaleString()} ตัวอักษร</p>
            <pre lang={document.format === 'raw' ? 'en' : undefined}>{document.content}</pre>
          </> : <p role="status">กำลังโหลดเนื้อหา…</p>}
        </article>
      </div>
    </div>}
  </section>
}
