import { EventEmitter } from 'events';
import lodashThrottle from 'lodash/throttle';
import * as mmb from 'music-metadata-browser';

class Playlist extends EventEmitter {
  state = {
    songs: [],
    initialized: false,
    playing: false,
    activeSongId: null,
    selectedSongId: null,
    volume: 0.75,
    mixVolume: 0.5,
    muted: false,
    loop: true,
    currentTime: 0,
    playThrough: true,
    channelVolume: [],
  };

  constructor(audioGraph) {
    super();
    this.audioGraph = audioGraph;
    this.setup();
  }

  setup() {
    this.gainNode = this.audioGraph.context.createGain();
    this.gainNode.gain.value = !this.state.muted ? this.state.volume : 0;
    this.mixGainNode = this.audioGraph.context.createGain();
    this.mixGainNode.gain.value = this.state.mixVolume;
    this.channelVolumeCapturerNode = this.audioGraph.createChannelVolumeCapturer();
    this.channelVolumeCapturerNode.oncapture = this._handleChannelVolumeCapture;
    this.playThroughNode = this.audioGraph.createPassThrough();
    this.playThroughNode.enabled = this.state.playThrough;

    this.gainNode.connect(this.channelVolumeCapturerNode);
    this.channelVolumeCapturerNode.connect(this.mixGainNode);
    this.mixGainNode.connect(this.audioGraph.get('stream'));

    this.gainNode.connect(this.playThroughNode);
    this.playThroughNode.connect(this.audioGraph.get('speaker'));
    this.state.initialized = true;
    this.emit('initialized');
  }

  _handleChannelVolumeCapture = lodashThrottle((channelVolume) => {
    if (this.state.playing) {
      this.state.channelVolume = channelVolume;
      this.emit('change:channelVolume', channelVolume);
    }
  }, 500);

  add(fileOrSong) {
    if (fileOrSong instanceof File) {
      this._handleAddFile(fileOrSong);
    } else if (fileOrSong.url) {
      this._handleAddSong(fileOrSong);
    }
  }

  _handleAddFile(file) {
    const id = Date.now() + Math.round(Math.random() * 1000).toString(16);
    const index = this.state.songs.length;
    this.state.songs = [...this.state.songs, { id, loading: true }];
    this.emit('change:songs', this.state.songs);
    this._getFileData(file).then((data) => {
      this.state.songs[index] = { id, ...data };
      this.state.songs = [...this.state.songs];
      this.emit('change:songs', this.state.songs);
    });
  }

  async _getFileData(file) {
    const metadata = await mmb.parseBlob(file, { duration: true });
    const coverPhoto = mmb.selectCover(metadata.common.picture);
    return {
      title:
        metadata.common.title ||
        file.name.substring(0, file.name.lastIndexOf('.')),
      artist: metadata.common.artist || 'Unknown Artist',
      duration: metadata.format.duration, // in s
      imageUrl: coverPhoto
        ? `data:${coverPhoto.format};base64,${coverPhoto.data.toString(
            'base64'
          )}`
        : '',
      file,
    };
  }

  _handleAddSong(song) {
    //
  }

  select(songId) {
    this.state.selectedSongId = songId;
    this.emit('change:selected', songId);
  }

  remove(songId) {
    if (songId === this.state.activeSongId) {
      this._onEnd();
    }

    const index = this.getSongIndex(songId);

    if (index !== -1) {
      this.state.songs.splice(index, 1);
      this.emit('change:songs', [...this.state.songs]);
    }
  }

  togglePlay() {
    if (this.state.activeSongId) {
      if (!this.state.playing) {
        this.play(this.state.activeSongId);
      } else {
        this.pause();
      }
    } else if (this.state.selectedSongId) {
      this.play(this.state.selectedSongId);
    } else if (this.state.initialized && this.state.songs.length > 0) {
      this.play(this.state.songs[0].id);
    }
  }

  play(songId) {
    const song = this.getSong(songId);

    if (!this.state.initialized) {
      this.setup();
    }

    // a resume?
    if (this.state.activeSongId === song.id && !this.state.playing) {
      this.sourceNode.play();
      this.state.playing = true;
      this.emit('play');
    } else if (this.state.activeSongId !== song.id) {
      // this.stop();
      if (this.sourceNode) {
        this.sourceNode.stop();
        this.sourceNode.el.removeEventListener('ended', this._onEnd);
        this.sourceNode.el.removeEventListener(
          'timeupdate',
          this._onTimeUpdate
        );
        this.sourceNode.disconnect();
        this.sourceNode = null;
      }

      this._setActiveSongId(song.id);
      this.select(song.id);
      this.audioGraph.createAudioSource(song).then((source) => {
        this.sourceNode = source;
        this.sourceNode.connect(this.gainNode);
        this.sourceNode.el.addEventListener('ended', this._onEnd.bind(this));
        this.sourceNode.el.addEventListener(
          'timeupdate',
          this._onTimeUpdate.bind(this)
        );
        this.state.playing = true;
        this.sourceNode.play();
        this.emit('play');
      });
    }
  }

  _onTimeUpdate = lodashThrottle((e) => {
    this.state.currentTime = e.target.currentTime; //in s
    this.emit('change:time', this.state.currentTime);
  }, 500);

  _onEnd() {
    // this.stop();
    this.next();
  }

  pause() {
    if (this.sourceNode) {
      this.sourceNode.pause();
      this.state.playing = false;
      this.emit('paused');
    }
  }

  stop() {
    this.sourceNode.stop();
    this.sourceNode.el.removeEventListener('ended', this._onEnd);
    this.sourceNode.el.removeEventListener('timeupdate', this._onTimeUpdate);
    this.sourceNode.disconnect();
    this.gainNode.disconnect();
    this.mixGainNode.disconnect();
    this.channelVolumeCapturerNode.disconnect();
    this.playThroughNode.disconnect();

    this.state.initialized = false;
    this.state.playing = false;
    this.state.activeSongId = null;
    this.state.currentTime = 0.0;

    this.sourceNode = null;
    this.gainNode = null;
    this.mixGainNode = null;
    this.channelVolumeCapturerNode = null;
    this.playThroughNode = null;

    this.emit('stopped');
  }

  next() {
    const activeSongIndex = this.getSongIndex(this.state.activeSongId);
    let nextSongIndex = activeSongIndex + 1;

    if (nextSongIndex >= this.state.songs.length) {
      if (this.state.loop) nextSongIndex = 0;
      else return;
    }

    this.play(this.state.songs[nextSongIndex].id);
  }

  previous() {
    const activeSongIndex = this.getSongIndex(this.state.activeSongId);
    let prevSongIndex = activeSongIndex - 1;

    if (prevSongIndex < 0) {
      if (this.state.loop) prevSongIndex = this.state.songs.length - 1;
      else return;
    }

    this.play(this.state.songs[prevSongIndex].id);
  }

  setVolume(value) {
    this.state.volume = value;
    this.gainNode.gain.value = value;
    this.emit('change:volume', value);
  }

  getVolume() {
    return this.state.volume;
  }

  setMixVolume(value) {
    this.state.mixVolume = value;
    this.mixGainNode.gain.value = value;
    // this.emit('change:mixVolume', value);
  }

  getMixVolume() {
    return this.state.mixVolume;
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

  seek(percent) {
    const currentTime = this.sourceNode.seek(percent);

    if (currentTime !== undefined) {
      this.state.currentTime = currentTime;
      this.emit('change:time', this.state.currentTime);
    }
  }

  toggleLoop() {
    this.setLoop(!this.state.loop);
  }

  setLoop(loop) {
    this.state.loop = loop;
    this.emit('change:loop', loop);
  }

  setPlayThrough(value) {
    this.state.playThrough = value;
    this.emit('change:playThrough', value);
  }

  setCurrentTime(value) {
    this.state.currentTime = value;
    this.emit('change:time', value);
  }

  getSongIndex(songId) {
    return this.state.songs.findIndex((song) => song.id === songId);
  }

  getActiveSong() {
    return this.getSong(this.state.activeSongId);
  }

  getSong(songId) {
    return this.state.songs.find((song) => song.id === songId);
  }

  _setActiveSongId(songId) {
    this.state.activeSongId = songId;
    this.emit('change:song', songId);
  }

  getCurrentState() {
    return this.state;
  }
}

export default Playlist;
