import { test } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { extractCurriculumFile, maxFileBytes, splitCurriculumBook } from './curriculum-files.mjs'
import { createRag } from './rag.mjs'

const content = 'Hello | สวัสดี\nThanks | ขอบคุณ\nGood morning | สวัสดีตอนเช้า'
const file = (name, buffer) => ({ originalname: name, buffer })

test('TXT and Markdown preserve Thai and reject invalid files', async () => {
  for (const name of ['lesson.txt', 'lesson.MD']) assert.equal((await extractCurriculumFile(file(name, Buffer.from(`\uFEFF${content.replaceAll('\n', '\r\n')}`)))).content, content)
  await assert.rejects(() => extractCurriculumFile(file('lesson.txt', Buffer.from([0xff, 0xfe, 0x00]))), /UTF-8/)
  await assert.rejects(() => extractCurriculumFile(file('lesson.exe', Buffer.from(content))), /รองรับ/)
  await assert.rejects(() => extractCurriculumFile(file('lesson.txt', Buffer.alloc(maxFileBytes + 1))), /50 MB/)
  await assert.rejects(() => extractCurriculumFile(file('lesson.txt', Buffer.from(''))), /ไฟล์ว่าง/)
  await assert.rejects(() => extractCurriculumFile(file('lesson.txt', Buffer.from('x'.repeat(30001)))), /30,000/)
  await assert.rejects(() => extractCurriculumFile(file('lesson.pdf', Buffer.from(content))), /PDF/)
})

test('book splitting ignores table of contents, groups repeated lesson headers and preserves text', () => {
  const pages = [
    { num: 1, text: 'Table of Contents\nLesson 1 Welcome 4\nLesson 2 Hello 12' },
    { num: 2, text: 'Let us Learn English\tLesson 1\t4\nLevel 1\nLesson 1\nWelcome\nHello there' },
    { num: 3, text: 'Let us Learn English\tLesson 1\t5\nThank you' },
    { num: 4, text: 'Let us Learn English\tLesson 2\t12\nLevel 1\nLesson 2\nHello\nNice to meet you' },
  ]
  const result = splitCurriculumBook({ title: 'Book', pages })
  assert.equal(result.length, 3)
  assert.equal(result[1].pageStart, 2)
  assert.equal(result[1].pageEnd, 3)
  assert.ok(result[1].content.includes('Hello there'))
  assert.ok(result[1].content.includes('Thank you'))
  const large = splitCurriculumBook({ title: 'Large', content: 'word '.repeat(15000) })
  assert.ok(large.length > 1)
  assert.ok(large.every((part) => part.content.length <= 24000))
})

test('DOCX extraction preserves English and Thai', async () => {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${content.split('\n').map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`)
  const result = await extractCurriculumFile(file('lesson.docx', await zip.generateAsync({ type: 'nodebuffer' })))
  assert.ok(result.content.includes('Hello | สวัสดี'))
  assert.ok(result.content.includes('Good morning | สวัสดีตอนเช้า'))
})

test('PDF extraction reads a real PDF page', async () => {
  const stream = 'BT /F1 12 Tf 40 700 Td (Hello. Thank you. Good morning. Nice to meet you.) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const start = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`
  assert.ok((await extractCurriculumFile(file('lesson.pdf', Buffer.from(pdf)))).content.includes('Nice to meet you'))
})

test('paired imports skip AI; plain text preparation rejects invented phrases', async () => {
  let calls = 0
  const exercises = [{ target: 'Hello', translation: 'สวัสดี' }, { target: 'Thank you', translation: 'ขอบคุณ' }, { target: 'Good morning', translation: 'สวัสดีตอนเช้า' }]
  const rag = createRag({ baseUrl: 'http://test', chatModel: 'test', fetcher: async () => {
    calls++
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ exercises }) } }) }
  } })
  assert.equal((await rag.prepareContent(content, 'A1')).translated, false)
  assert.equal(calls, 0)
  const result = await rag.prepareContent('Hello. Thank you. Good morning. Speaking greetings in daily life.', 'A1')
  assert.equal(result.translated, true)
  assert.ok(result.content.includes('Thank you | ขอบคุณ'))
  exercises[0].target = 'Invented phrase'
  await assert.rejects(() => rag.prepareContent('Hello. Thank you. Good morning.', 'A1'), /ไม่ตรง/)
})
