import { EventEmitter } from 'events';
import adapter from 'webrtc-adapter';
import JanusAudioBridgeClient from './helpers/audio-bridge-client';
import AudioGraph from './helpers/audiograph';
import Microphone from './helpers/microphone';
import Playlist from './helpers/playlist';

class XAudioClient extends EventEmitter {
  state = {
    userId: null,
    initialized: false,
    starting: false,
    streaming: false,
    recording: false,
    stream: null,
    listeners: [],
    muted: false,
    volume: 1,
    mixer: {
      value: 0.5,
      leftVolume: 1,
      rightVolume: 1,
    },
  };

  createMicrophone() {
    return new Microphone(this.audioGraph);
  }

  createPlaylist() {
    return new Playlist(this.audioGraph);
  }

  constructor(config) {
    super();
    this.audioGraph = new AudioGraph();
    this.serverClient = new JanusAudioBridgeClient(config);
    this.serverClient.on('change', this._handleServerClientChanged);
    this.serverClient.on('joined', this._handleServerClientJoined);
    this.serverClient.on('stream:remote', this._handleRemoteStream);
    this.serverClient.on('error', this._handleServerClientError);
    this.serverClient.on('close', this._handleServerClientClose);
    this.streamHandler = new StreamHandler(this.audioGraph);
  }

  _handleServerClientJoined = ({ id }) => {
    this.state.userId = id;
    this.__emitChange();
  };

  _handleServerClientChanged = (newState) => {
    this.state.initialized = newState.initialized;
    this.state.recording = newState.recording;
    this.state.starting = newState.starting;
    this.state.streaming = newState.streaming;
    this.state.listeners = newState.participants;
    this.__emitChange();
  };

  _handleRemoteStream = (stream) => {
    this.streamHandler.handle(stream);
    this.state.stream = stream;
    this.emit('stream', stream);
    this.__emitChange();
  };

  _handleServerClientError = (error) => {
    this.emit('error', error);
  };

  _handleServerClientClose = () => {
    this.__emitChange();
    this.emit('close');
  };

  _handleStreamHandlerData = (data) => {
    //
  };

  async start(record) {
    this.audioGraph.context.resume();
    await this.serverClient.start({
      record,
      stream: this.audioGraph.get('stream').stream,
    });
  }

  async stop() {
    if (this.streamNode) {
      this.streamNode.disconnect();
      this.streamNode = null;
    }
    await this.serverClient.stop();
  }

  toggleMute() {
    if (this.state.muted) {
      this.unmute();
    } else {
      this.mute();
    }
  }

  async enableToTransmit() {
    await this.serverClient.unmute();
  }

  mute() {
    // await this.serverClient.mute();
    this.audioGraph.get('speaker').gain.value = 0;
    this.state.muted = true;
    this.__emitChange();
  }

  unmute() {
    // await this.serverClient.unmute();
    this.audioGraph.get('speaker').gain.value = this.state.volume;
    this.state.muted = false;
    this.__emitChange();
  }

  setVolume(value) {
    this.state.volume = Math.max(0, Math.min(value, 1));
    this.audioGraph.get('speaker').gain.value = this.state.volume;
    this.__emitChange();
  }

  attachStreamTo(audioEl) {
    adapter.browserShim.attachMediaStream(audioEl, this.state.stream);
  }

  setMixerValue(value) {
    const normalize = (val) => (val < 0.5 ? 2 * val : 1);

    this.state.mixer = {
      value,
      leftVolume: normalize(1 - value),
      rightVolume: normalize(value),
    };
    this.__emitChange();
  }

  __emitChange() {
    this.emit('change', this.state);
  }

  getCurrentState() {
    return this.state;
  }

  getStream() {
    return this.state.stream;
  }

  getStreamAudioData() {
    return this.streamHandler.getAudioData();
  }
}

class StreamHandler {
  state = {};
  constructor(audioGraph) {
    this.audioGraph = audioGraph;
    this.analyserNode = this.audioGraph.context.createAnalyser();
    this.analyserNode.connect(this.audioGraph.get('speaker'));
    this.analyserNode.fftSize = 16384;
    this.state.bufferLength = this.analyserNode.frequencyBinCount;
    this.state.data = new Uint8Array(this.state.bufferLength);
  }

  handle(stream) {
    if (this.streamNode) {
      this.streamNode.disconnect();
    }

    this.streamNode = this.audioGraph.context.createMediaStreamSource(stream);
    this.streamNode.connect(this.analyserNode);
  }

  getAudioData() {
    this.analyserNode.getByteFrequencyData(this.state.data);
    return {
      bufferLength: this.state.bufferLength,
      data: this.state.data,
    };
  }
}

export default XAudioClient;
