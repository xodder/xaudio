class AudioGraph {
  nodes = {};

  constructor() {
    this.context = new AudioContext();
    this.set('speaker', this.context.createGain());
    this.set('output', this.context.destination);
    this.set('stream', this.context.createMediaStreamDestination());
    this.connect('speaker', 'output');
  }

  has(key) {
    return key in this.nodes;
  }

  set(key, node) {
    if (this.nodes[key]) {
      this.disconnect(key);
    }
    this.nodes[key] = node;
  }

  get(key) {
    return this.nodes[key];
  }

  connect(sourceKey, destinationKey) {
    this.get(sourceKey).connect(this.get(destinationKey));
  }

  disconnect(key) {
    this.get(key).disconnect();
    delete this.nodes[key];
  }

  async createAudioSource(song) {
    return new Promise((resolve) => {
      const audioEl = new Audio(URL.createObjectURL(song.file));
      audioEl.controls = false;
      audioEl.autoplay = false;
      audioEl.loop = false;
      audioEl.addEventListener('canplay', () => {
        const source = this.context.createMediaElementSource(audioEl);
        source.el = audioEl;
        source.play = () => audioEl.play();
        source.position = () => audioEl.currentTime;
        source.duration = () => audioEl.duration;
        source.paused = () => audioEl.paused;
        source.stop = () => {
          audioEl.pause();
          audioEl.remove();
        };
        source.pause = () => audioEl.pause();
        source.seek = (percent) => {
          const time = percent * song.duration;
          audioEl.currentTime = time;
          return time;
        };
        resolve(source);
      });
    });
  }

  async createMicrophoneSource() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = this.context.createMediaStreamSource(stream);
    source.stop = () => {
      const audioTracks = stream.getAudioTracks();
      if (audioTracks[0]) {
        audioTracks[0].stop();
      }
    };
    return source;
  }

  createChannelVolumeCapturer() {
    const bufferSize = 4096;
    const bufferSizeLog = Math.log(bufferSize);
    const log10 = 2.0 * Math.log(10);

    const capturer = this.context.createScriptProcessor(bufferSize, 2, 2);
    capturer.oncapture = () => {};
    capturer.addEventListener('audioprocess', (buffer) => {
      const channelVolume = [];
      const channelCount = buffer.inputBuffer.numberOfChannels;

      for (let channel = 0; channel < channelCount; channel++) {
        const channelData = buffer.inputBuffer.getChannelData(channel);

        let rms = 0;
        for (let i = 0; i < channelData.length; i++) {
          rms += Math.pow(channelData[i], 2);
        }
        const volume = 100 * Math.exp((Math.log(rms) - bufferSizeLog) / log10);

        channelVolume[channel] = volume;

        capturer.oncapture(channelVolume);

        buffer.outputBuffer.getChannelData(channel).set(channelData);
      }
    });
    return capturer;
  }

  createPassThrough() {
    const node = this.context.createScriptProcessor(256, 2, 2);

    node.addEventListener('audioprocess', (buffer) => {
      const channelCount = buffer.inputBuffer.numberOfChannels;
      const channelData = buffer.inputBuffer.getChannelData(0);

      for (let channel = 0; channel < channelCount; channel++) {
        if (node.enabled) {
          buffer.outputBuffer.getChannelData(channel).set(channelData);
        } else {
          buffer.outputBuffer
            .getChannelData(channel)
            .set(new Float32Array(channelData.length));
        }
      }
    });
    return node;
  }
}

export default AudioGraph;
