import { useEffect, useRef, useState } from 'react'
import { createExampleAudio, type AudioSpeed } from './example-audio'

export function useExampleAudio() {
  const [player] = useState(createExampleAudio)
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => () => { generation.current++; player.stop() }, [player])
  function stop() { generation.current++; player.stop(); setState('idle') }
  function play(text: string, speed: AudioSpeed = 'normal', onEnd?: () => void) {
    const current = ++generation.current
    setError('')
    void player.play(text, speed, {
      onLoading: () => { if (current === generation.current) setState('loading') },
      onPlaying: () => { if (current === generation.current) setState('playing') },
      onStop: () => { if (current === generation.current) setState('idle') },
      onEnd: () => { if (current === generation.current) { setState('idle'); onEnd?.() } },
      onError: message => { if (current === generation.current) { setState('idle'); setError(message) } },
    })
  }
  return { play, stop, state, error }
}
