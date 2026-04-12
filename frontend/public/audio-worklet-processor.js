const HOP_LENGTH = 1470; // 44100 Hz / 30 fps

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(HOP_LENGTH);
    this._offset = 0;
  }

  process(inputs, _outputs, _parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const channelData = input[0]; // mono — first channel only
    let i = 0;

    while (i < channelData.length) {
      const remaining = HOP_LENGTH - this._offset;
      const toCopy = Math.min(remaining, channelData.length - i);

      this._buffer.set(channelData.subarray(i, i + toCopy), this._offset);
      this._offset += toCopy;
      i += toCopy;

      if (this._offset === HOP_LENGTH) {
        this.port.postMessage(this._buffer.slice());
        this._offset = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
