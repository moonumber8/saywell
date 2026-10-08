// The samples leave this processor only for the current in-memory recording.
class SaywellMic extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0]
    if (input?.length) {
      const samples = new Float32Array(input)
      this.port.postMessage(samples, [samples.buffer])
    }
    return true
  }
}
registerProcessor('saywell-mic', SaywellMic)
