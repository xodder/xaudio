import { EventEmitter } from 'events';
import lodashThrottle from 'lodash/throttle';

class Microphone extends EventEmitter {
  state = {
    initialized: false,
    on: false,
    volume: 1,
    channelVolume: [0, 0],
    playThrough: false,
    muted: false,
  };

  constructor(audioGraph) {
    super();
    this.audioGraph = audioGraph;
    this.setup();
  }

  setup() {
    this.gainNode = this.audioGraph.context.createGain();
    this.gainNode.gain.value = !this.state.muted ? this.state.volume : 0;
    this.channelVolumeCapturerNode = this.audioGraph.createChannelVolumeCapturer();
    this.channelVolumeCapturerNode.oncapture = this._handleChannelVolumeCapture;
    this.playThroughNode = this.audioGraph.createPassThrough();
    this.playThroughNode.enabled = this.state.playThrough;

    this.gainNode.connect(this.channelVolumeCapturerNode);
    this.channelVolumeCapturerNode.connect(this.audioGraph.get('stream'));

    this.gainNode.connect(this.playThroughNode);
    this.playThroughNode.connect(this.audioGraph.get('speaker'));
    this.playThroughNode.enabled = false;
    this.state.initialized = true;
    this.emit('initialized');
  }

  _handleChannelVolumeCapture = lodashThrottle((channelVolume) => {
    if (this.state.on) {
      this.state.channelVolume = channelVolume;
      this.emit('change:channelVolume', channelVolume);
    }
  }, 500);

  async toggleOn() {
    if (!this.state.on) {
      await this.switchOn();
    } else {
      this.switchOff();
    }
  }

  async switchOn() {
    if (!this.state.initialized) {
      this.setup();
    }

    this.sourceNode = await this.audioGraph.createMicrophoneSource();
    this.sourceNode.connect(this.gainNode);
    this.state.on = true;
    this.emit('on');
  }

  switchOff() {
    if (this.state.on) {
      this.sourceNode.stop();
      this.sourceNode.disconnect();
      this.gainNode.disconnect();
      this.channelVolumeCapturerNode.disconnect();
      this.playThroughNode.disconnect();

      this.state.initialized = false;
      this.state.on = false;

      this.sourceNode = null;
      this.gainNode = null;
      this.channelVolumeCapturerNode = null;
      this.playThroughNode = null;
      this.emit('off');
    }
  }

  setVolume(value) {
    this.state.volume = value;
    this.gainNode.gain.value = value;
    this.emit('change:volume', value);
  }

  togglePlayThrough() {
    this.state.playThrough = !this.state.playThrough;
    this.playThroughNode.enabled = this.state.playThrough;
    this.emit('change:playThrough', this.state.playThrough);
  }

  toggleMute() {
    if (!this.state.mute) {
      this.mute();
    } else {
      this.unmute();
    }
  }

  mute() {
    this.state.mute = true;
    this.gainNode.gain.value = 0;
    this.emit('change:mute', this.state.mute);
  }

  unmute() {
    this.state.mute = false;
    this.gainNode.gain.value = this.state.volume;
    this.emit('change:mute', this.state.mute);
  }

  getCurrentState() {
    return this.state;
  }
}

export default Microphone;
