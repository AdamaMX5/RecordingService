'use strict';

/**
 * In-memory store for active and completed recordings.
 *
 * Recording state shape:
 * {
 *   id:                  string   (uuid)
 *   roomName:            string
 *   participantIdentity: string
 *   status:              'connecting' | 'recording' | 'stopping' | 'merging' | 'completed' | 'error'
 *   startTime:           Date
 *   endTime:             Date | null
 *   outputPath:          string | null   absolute path to final .webm
 *   relativeOutputPath:  string | null   path relative to recordingsDir
 *   filename:            string | null
 *   error:               string | null
 *   // internal – not returned via API
 *   _room:               Room | null
 *   _videoProc:          ChildProcess | null
 *   _audioProc:          ChildProcess | null
 *   _videoStream:        VideoStream | null
 *   _audioStream:        AudioStream | null
 *   _tmpVideoPath:       string | null
 *   _tmpAudioPath:       string | null
 *   _hasVideo:           boolean
 *   _hasAudio:           boolean
 * }
 */

class RecordingStore {
  constructor() {
    /** @type {Map<string, object>} */
    this._recordings = new Map();
    /** @type {Map<string, Set<string>>} roomName → Set of recordingIds */
    this._roomIndex = new Map();
    /** @type {Map<string, string>} "room:identity" → recordingId */
    this._participantIndex = new Map();
  }

  add(recording) {
    this._recordings.set(recording.id, recording);

    if (!this._roomIndex.has(recording.roomName)) {
      this._roomIndex.set(recording.roomName, new Set());
    }
    this._roomIndex.get(recording.roomName).add(recording.id);

    const key = `${recording.roomName}:${recording.participantIdentity}`;
    this._participantIndex.set(key, recording.id);
  }

  get(id) {
    return this._recordings.get(id) || null;
  }

  getByRoom(roomName) {
    const ids = this._roomIndex.get(roomName);
    if (!ids) return [];
    return [...ids].map(id => this._recordings.get(id)).filter(Boolean);
  }

  getActiveByRoom(roomName) {
    return this.getByRoom(roomName).filter(r =>
      r.status === 'connecting' || r.status === 'recording'
    );
  }

  getByParticipant(roomName, identity) {
    const key = `${roomName}:${identity}`;
    const id = this._participantIndex.get(key);
    return id ? this._recordings.get(id) || null : null;
  }

  getActiveByParticipant(roomName, identity) {
    const rec = this.getByParticipant(roomName, identity);
    if (!rec) return null;
    return (rec.status === 'connecting' || rec.status === 'recording') ? rec : null;
  }

  update(id, fields) {
    const rec = this._recordings.get(id);
    if (!rec) return;
    Object.assign(rec, fields);
  }

  remove(id) {
    const rec = this._recordings.get(id);
    if (!rec) return;
    this._recordings.delete(id);
    this._roomIndex.get(rec.roomName)?.delete(id);
    const key = `${rec.roomName}:${rec.participantIdentity}`;
    if (this._participantIndex.get(key) === id) {
      this._participantIndex.delete(key);
    }
  }

  getAll() {
    return [...this._recordings.values()];
  }

  /** Return a plain object safe for API responses (no internal fields). */
  toPublic(recording) {
    const { id, roomName, participantIdentity, status, startTime, endTime,
      relativeOutputPath, filename, error } = recording;
    return { id, roomName, participantIdentity, status, startTime, endTime,
      path: relativeOutputPath, filename, error };
  }
}

module.exports = new RecordingStore();
