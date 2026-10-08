import { extname, basename } from 'node:path'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'

export const supportedExtensions = new Set(['.txt', '.md', '.pdf', '.docx'])
export const maxFileBytes = 50 * 1024 * 1024

export function normalizeText(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim()
}

export async function extractCurriculumFile(file, { large = false } = {}) {
  const extension = extname(file.originalname).toLowerCase()
  if (!supportedExtensions.has(extension)) throw new Error('รองรับไฟล์ TXT, Markdown, PDF และ DOCX เท่านั้น')
  if (!file.buffer.length || file.buffer.length > maxFileBytes) throw new Error('ไฟล์ต้องมีขนาดไม่เกิน 50 MB และไม่เป็นไฟล์ว่าง')
  let content
  let pages
  if (extension === '.pdf') {
    if (!file.buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('ไฟล์นี้ไม่ใช่ PDF ที่ถูกต้อง')
    const parser = new PDFParse({ data: file.buffer })
    try { const result = await parser.getText(); content = result.text; pages = result.pages }
    finally { await parser.destroy() }
  } else if (extension === '.docx') {
    content = (await mammoth.extractRawText({ buffer: file.buffer })).value
  } else {
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer) }
    catch { throw new Error('กรุณาบันทึกไฟล์ข้อความเป็น UTF-8') }
  }
  content = normalizeText(content)
  if (content.length < 30) throw new Error('ไม่พบข้อความเพียงพอในไฟล์ หากเป็น PDF สแกน กรุณาแปลงเป็นข้อความก่อน')
  if (content.length > (large ? 2000000 : 30000)) throw new Error(large ? 'ข้อความในไฟล์เกิน 2 ล้านตัวอักษร' : 'ไฟล์ยาวเกิน 30,000 ตัวอักษร กรุณาใช้ปุ่มนำเข้าทั้งเล่ม')
  return { title: basename(file.originalname, extension).slice(0, 120), content, pages }
}

export function splitCurriculumBook({ title, content, pages }) {
  const groups = []
  if (pages?.length) {
    for (const page of pages) {
      // Read the page header, not the table of contents or mentions in body text.
      const header = page.text.split('\n')[0]
      const number = header.match(/\bLesson\s+(\d+)\b/i)?.[1]
      const previous = groups.at(-1)
      if (!previous || (number && number !== previous.number)) {
        groups.push({ number, title: number ? `${title} — Lesson ${number}` : `${title} — Introduction`, content: '', pageStart: page.num, pageEnd: page.num })
      }
      const group = groups.at(-1)
      group.content += `${page.text}\n`
      group.pageEnd = page.num
    }
  } else {
    const sections = content.split(/(?=^(?:#{1,3}\s*)?(?:Lesson|Unit|Chapter)\s+\d+\b)/gim)
    sections.filter((part) => part.trim()).forEach((part, index) => groups.push({ title: `${title} — ${part.split('\n')[0].slice(0, 80) || `Part ${index + 1}`}`, content: part }))
  }
  // Keep all text; split oversized sections further without breaking source lines.
  const result = []
  for (const group of groups) {
    const lines = normalizeText(group.content).split('\n').flatMap((line) => line.match(/.{1,1000}/gu) ?? [''])
    let current = ''
    const parts = []
    for (const line of lines) {
      if (current.length + line.length > 24000 && current) { parts.push(current); current = '' }
      current += `${line}\n`
    }
    if (current.trim()) parts.push(current)
    parts.forEach((part, index) => result.push({ ...group, title: `${group.title}${parts.length > 1 ? ` — Part ${index + 1}` : ''}`.slice(0, 160), content: part.trim() }))
  }
  if (!result.length || result.length > 1000) throw new Error('แบ่งหลักสูตรไม่ได้ หรือจำนวนบทเกิน 1,000 บท')
  return result
}
