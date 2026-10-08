export async function readLessonStream<T>(response: Response, onProgress: (message: string) => void): Promise<T> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'สร้างบทเรียนไม่ได้ กรุณาลองใหม่')
    return data as T
  }
  if (!response.body) throw new Error('ไม่ได้รับข้อมูลบทเรียน กรุณาลองใหม่')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (done && buffer.trim()) lines.push(buffer)
      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line)
        if (event.type === 'progress') onProgress(event.message)
        if (event.type === 'error') throw new Error(event.error)
        if (event.type === 'lesson') return event.lesson as T
      }
      if (done) throw new Error('การเชื่อมต่อขาดก่อนสร้างบทเรียนเสร็จ กรุณาลองใหม่')
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
