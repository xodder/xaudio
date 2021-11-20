import { EventEmitter } from 'events';
import Janus from './janus';

class JanusAudioBridgeClient extends EventEmitter {
  state = {
    initialized: false,
    starting: false, // when the start func is called
    attached: false,
    streaming: false,
    recording: false,
    participants: [],
  };

  __pendingParcels = [];
  __pendingSetupTask = null;

  constructor(config) {
    super();
    this.config = config;
    Janus.init({
      debug: 'all',
      callback: () => this.__init(),
    });
  }

  __init() {
    this.janus = new Janus({
      server: this.config.address,
      success: () => {
        this.state.initialized = true;
        this.__emitChange();
        if (this.__pendingSetupTask) {
          this.__pendingSetupTask.resolve();
          this.__pendingSetupTask = null;
        }
      },
      error: (cause) => {
        this.__handlePluginError({ message: cause });
      },
      destroyed: () => {
        this.__handlePluginClose();
      },
    });
  }

  async __setup() {
    if (!this.state.initialized) {
      return new Promise((resolve, reject) => {
        this.__pendingSetupTask = {
          resolve: () => {
            this.__setup().then(resolve, reject);
          },
        };
      });
    }

    const opaqueId = 'audiobridge-' + Janus.randomString(12);
    return new Promise((resolve, reject) => {
      this.janus.attach({
        plugin: 'janus.plugin.audiobridge',
        opaqueId,
        success: (handle) => {
          this.plugin = handle;
          this.state.attached = true;
          this.__emitChange();
          resolve();
        },
        error: (e) => {
          // Couldn't attach to the plugin
          reject(e);
        },
        onmessage: (msg, jsep) => {
          this.__handlePluginMesssage(msg, jsep);
        },
        onlocalstream: (stream) => {
          this.__handlePluginLocalStream(stream);
        },
        onremotestream: (stream) => {
          this.__handlePluginRemoteStream(stream);
        },
        ondataopen: () => {
          //
        },
        ondata: () => {
          //
        },
        oncleanup: () => {
          // PeerConnection with the plugin closed, clean the UI
          this.__handlePluginClose();
        },
        detached: () => {
          // Connection with the plugin closed, get rid of its features
          // The plugin handle is not valid anymore
          this.__handlePluginClose();
        },
      });
    });
  }

  __handlePluginMesssage = (message, jsep) => {
    this.__processPendingParcels(message);
    this.__processParticipants(message);

    // handle special events
    const eventName = message.audiobridge;

    if (eventName === 'destroyed') {
      this.__handlePluginClose();
    } else if (eventName === 'event') {
      if (message.error_code || message.error) {
        this.__handlePluginError({
          code: message.error_code,
          message: message.error,
        });
      }
    }

    if (jsep) {
      this.plugin.handleRemoteJsep({ jsep });
    }

    this.emit('message', message);
  };

  __processPendingParcels = (message) => {
    // to prevent unneccesary filtering parcels
    let hadMatch = false;

    for (let parcel of this.__pendingParcels) {
      if (parcel.isMatch(message)) {
        parcel.success(message);
        parcel.resolved = true;
        hadMatch = true;
      }
    }

    // remove fulfilled parcels
    if (hadMatch) {
      this.__pendingParcels = this.__pendingParcels.filter((p) => !p.resolved);
    }
  };

  __processParticipants(message) {
    if (message.participants) {
      message.participants.forEach((participant) => {
        const index = this.state.participants.findIndex(
          (p) => p.id === participant.id
        );
        if (index === -1) {
          this.state.participants.push(participant);
        } else {
          this.state.participants[index] = participant;
        }
      });
      this.__emitChange();
    } else if (message.leaving) {
      const index = this.state.participants.findIndex(
        (p) => p.id === message.leaving
      );
      if (index !== -1) {
        this.state.participants.splice(index, 1);
        this.__emitChange();
      }
    }
  }

  __handlePluginLocalStream = (stream) => {
    this.emit('stream:local', stream);
  };

  __handlePluginRemoteStream = (stream) => {
    this.emit('stream:remote', stream);
  };

  __handlePluginError = (error) => {
    this.emit('error', error);
    if (this.state.starting) {
      this.stop();
    }
  };

  __handlePluginClose = (e) => {
    this.emit('close');
  };

  async start({ record, stream }) {
    this.state.starting = true;
    this.__emitChange();

    if (!this.plugin || !this.state.attached) {
      await this.__setup();
    }

    const streamConfig = {
      ...this.config.stream,
      options: { ...this.config.stream.options, record },
    };

    if (this.isOwner()) {
      const exists = await this.__roomExists(streamConfig.id);
      if (exists) {
        await this.__destroyRoom(streamConfig);
      }
      await this.__createRoom(streamConfig);
      // emit room created event
    }

    const joinData = await this.__joinRoom(streamConfig);
    this.emit('joined', { id: joinData.id });
    await this.__offerStream(stream);
    this.state.starting = false;
    this.state.streaming = true;
    this.state.recording = record;
    this.__emitChange();
  }

  __roomExists(roomId) {
    return this.sendParcel({
      data: {
        request: 'exists',
        room: roomId,
      },
      isMatch: (e) => 'exists' in e && e.audiobridge === 'success',
      result: (e) => e.exists,
    });
  }

  async __createRoom(roomConfig) {
    return this.sendParcel({
      data: {
        request: 'create',
        room: roomConfig.id,
        description: roomConfig.description,
        ...roomConfig.options,
      },
      isMatch: (e) => e.audiobridge === 'created',
    });
  }

  async __destroyRoom(roomConfig) {
    return this.sendParcel({
      data: {
        request: 'destroy',
        room: roomConfig.id,
        secret: roomConfig.options.secret,
      },
      isMatch: (e) => e.audiobridge === 'destroyed',
    });
  }

  async __joinRoom(roomConfig) {
    return this.sendParcel({
      data: {
        request: 'join',
        room: roomConfig.id,
        ...roomConfig.options,
      },
      isMatch: (e) => e.audiobridge === 'joined',
    });
  }

  async __offerStream(stream) {
    return new Promise((resolve, reject) => {
      this.plugin.createOffer({
        stream,
        success: (jsep) => {
          this.sendParcel({
            data: {
              request: 'configure',
              muted: !this.isOwner(),
            },
            jsep,
            isMatch: (e) => e.result === 'ok',
          }).then(resolve);
        },
        error: (error) => {
          reject(error);
        },
      });
    });
  }

  async sendParcel(parcel) {
    return new Promise((resolve, reject) => {
      // if is synchronous
      if (!this.__isAsynchronusParcel(parcel)) {
        this.plugin.send({
          message: parcel.data,
          jsep: parcel.jsep,
          success: (data) => {
            resolve(parcel.result ? parcel.result(data) : data);
          },
          error: (e) => {
            reject(e);
          },
        });
      } else {
        this.__pendingParcels.push({
          isMatch: parcel.isMatch,
          success: (data) =>
            resolve(parcel.result ? parcel.result(data) : data),
          error: (error) => reject(error),
        });
        this.plugin.send({ message: parcel.data, jsep: parcel.jsep });
      }
    });
  }

  __isAsynchronusParcel(parcel) {
    return ['join', 'configure', 'changeroom', 'leave'].includes(
      parcel.data.request
    );
  }

  async stop() {
    this.state.attached = false;
    this.state.starting = false;
    this.state.streaming = false;
    this.state.recording = false;

    if (this.isOwner()) {
      await this.__destroyRoom(this.config.stream);
    }

    this.janus.destroy();
    this.__emitChange();
  }

  async configure(options) {
    return this.sendParcel({
      data: {
        ...options,
      },
    });
  }

  async getParticipants() {
    this.state.participants = await this.sendParcel({
      data: {
        request: 'listparticipants',
        room: this.config.stream.id,
      },
      isMatch: (e) => e.audiobridge === 'participants',
      result: (e) => e.participants || [],
    });
    return this.state.participants;
  }

  async mute() {
    await this.configure({ muted: true });
  }

  async unmute() {
    await this.configure({ muted: false });
  }

  isOwner() {
    return this.config.stream.owner;
  }

  getCurrentState() {
    return this.state;
  }

  __emitChange() {
    this.emit('change', this.state);
  }
}

export default JanusAudioBridgeClient;
