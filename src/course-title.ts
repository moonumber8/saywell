// Imported files can have generated UUID names. Keep the chapter name readable.
export function displayCourseTitle(title: string) {
  return title.replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\s*[—–]\s*/i, '')
}
