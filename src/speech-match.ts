export function words(text: string): string[] {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9'\s]/g, ' ').trim().split(/\s+/).filter(Boolean)
}

export const speechPassThreshold = 85

// Word edit distance counts substitutions, missing words and extra words.
// This measures agreement with ASR text, not acoustic pronunciation quality.
function wordDistance(expected: string[], spoken: string[]): number {
  let previous = Array.from({ length: spoken.length + 1 }, (_, index) => index)
  for (let i = 1; i <= expected.length; i++) {
    const current = [i]
    for (let j = 1; j <= spoken.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + Number(expected[i - 1] !== spoken[j - 1]),
      )
    }
    previous = current
  }
  return previous[spoken.length]
}

// Align words in order so repeated words cannot reuse one spoken word.
export function matchSpeech(target: string, transcript: string) {
  const expected = words(target)
  const spoken = words(transcript)
  const table = Array.from({ length: expected.length + 1 }, () => Array<number>(spoken.length + 1).fill(0))
  for (let i = 1; i <= expected.length; i++) {
    for (let j = 1; j <= spoken.length; j++) {
      table[i][j] = expected[i - 1] === spoken[j - 1]
        ? table[i - 1][j - 1] + 1
        : Math.max(table[i - 1][j], table[i][j - 1])
    }
  }
  const matched = expected.map(() => false)
  let i = expected.length
  let j = spoken.length
  while (i > 0 && j > 0) {
    if (expected[i - 1] === spoken[j - 1]) {
      matched[--i] = true
      j--
    } else if (table[i - 1][j] >= table[i][j - 1]) i--
    else j--
  }
  const score = expected.length && spoken.length
    ? Math.max(0, Math.round(100 * (1 - wordDistance(expected, spoken) / Math.max(expected.length, spoken.length))))
    : 0
  return { matched, score, passed: expected.length > 0 && spoken.length > 0 && score >= speechPassThreshold }
}
