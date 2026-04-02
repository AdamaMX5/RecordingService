'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ffmpegPath = require('ffmpeg-static');
const { Room, RoomEvent, VideoStream, AudioStream, TrackKind } = require('@livekit/rtc-node');

const config = require('../config');
const logger = require('../logger');
const store = require('../store/recordingStore');
const { createRecorderToken } = require('./livekitService');

// ─── Path helpers ────────────────────────────────────────────────────────────

/** Replace characters that are unsafe in file/directory names. */
function sanitize(str) {
  return str.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function buildOutputPaths(roomName, participantIdentity, recordingId) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);                          // YYYY-MM-DD
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');       // HH-MM-SS

  const safeRoom        = sanitize(roomName);
  const safeIdentity    = sanitize(participantIdentity);
  const filename        = `${safeIdentity}_${timeStr}.webm`;
  const relativeDir     = path.join(safeRoom, dateStr);
  const outputDir       = path.join(config.recordingsDir, relativeDir);
  const outputPath      = path.join(outputDir, filename);
  const relativeOutput  = path.join(relativeDir, filename);
  const tmpDir          = path.join(config.recordingsDir, '.tmp');
  const tmpVideoPath    = path.join(tmpDir, `${recordingId}_video.webm`);
  const tmpAudioPath    = path.join(tmpDir, `${recordingId}_audio.webm`);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(tmpDir,    { recursive: true });

  return { filename, outputPath, relativeOutput, tmpVideoPath, tmpAudioPath };
}

// ─── FFmpeg process helpers ──────────────────────────────────────────────────

function spawnVideoFfmpeg(outputPath) {
  const { videoWidth, videoHeight, fps, videoBitrate, cpuUsed, deadline } = config.recording;

  const args = [
    '-f',            'rawvideo',
    '-pixel_format', 'yuv420p',
    '-video_size',   `${videoWidth}x${videoHeight}`,
    '-framerate',    String(fps),
    '-i',            'pipe:0',
    '-c:v',          'libvpx-vp9',
    '-b:v',          videoBitrate,
    '-deadline',     deadline,
    '-cpu-used',     String(cpuUsed),
    '-row-mt',       '1',
    '-an',
    '-y',
    outputPath,
  ];

  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  proc.stderr.on('data', d => logger.debug(`[ffmpeg-video] ${d.toString().trim()}`));
  proc.on('error', err => logger.error(`[ffmpeg-video] spawn error: ${err.message}`));
  return proc;
}

function spawnAudioFfmpeg(outputPath) {
  const { audioSampleRate, audioChannels, audioBitrate } = config.recording;

  const args = [
    '-f',  's16le',
    '-ar', String(audioSampleRate),
    '-ac', String(audioChannels),
    '-i',  'pipe:0',
    '-c:a', 'libopus',
    '-b:a', audioBitrate,
    '-vn',
    '-y',
    outputPath,
  ];

  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  proc.stderr.on('data', d => logger.debug(`[ffmpeg-audio] ${d.toString().trim()}`));
  proc.on('error', err => logger.error(`[ffmpeg-audio] spawn error: ${err.message}`));
  return proc;
}

/** Resolve when the process exits; rejects if exit code is non-zero. */
function waitForProcess(proc) {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', code => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
    proc.once('error', reject);
  });
}

/** Merge separate video-only and audio-only WebM files into one. */
async function mergeWebm({ tmpVideoPath, tmpAudioPath, outputPath, _hasVideo, _hasAudio }) {
  const hasV = _hasVideo && fs.existsSync(tmpVideoPath);
  const hasA = _hasAudio && fs.existsSync(tmpAudioPath);

  if (hasV && hasA) {
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, [
        '-i', tmpVideoPath,
        '-i', tmpAudioPath,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-y',
        outputPath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      proc.stderr.on('data', d => logger.debug(`[ffmpeg-merge] ${d.toString().trim()}`));
      proc.once('exit', code => (code === 0 || code === null ? resolve() : reject(new Error(`merge exit ${code}`))));
      proc.once('error', reject);
    });
  } else if (hasV) {
    fs.copyFileSync(tmpVideoPath, outputPath);
  } else if (hasA) {
    fs.copyFileSync(tmpAudioPath, outputPath);
  } else {
    throw new Error('No video or audio was captured');
  }
}

function cleanupTmp(...filePaths) {
  for (const p of filePaths) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* best-effort */ }
  }
}

// ─── Track piping ────────────────────────────────────────────────────────────

function pipeVideoToFfmpeg(recordingId, track) {
  const { videoWidth, videoHeight } = config.recording;
  const videoStream = new VideoStream(track, videoWidth, videoHeight);
  store.update(recordingId, { _videoStream: videoStream, _hasVideo: true });

  // Fire-and-forget – the loop ends when videoStream.close() is called
  // or when the track is unpublished / room disconnects.
  (async () => {
    try {
      for await (const frame of videoStream) {
        const rec = store.get(recordingId);
        if (!rec || !rec._videoProc?.stdin?.writable) break;

        const ok = rec._videoProc.stdin.write(Buffer.from(frame.data));
        if (!ok) {
          // Respect backpressure
          await new Promise(resolve => rec._videoProc.stdin.once('drain', resolve));
        }
      }
    } catch (err) {
      logger.debug(`[${recordingId}] video stream ended: ${err.message}`);
    } finally {
      const rec = store.get(recordingId);
      if (rec?._videoProc?.stdin?.writable) rec._videoProc.stdin.end();
    }
  })();
}

function pipeAudioToFfmpeg(recordingId, track) {
  const { audioSampleRate, audioChannels } = config.recording;
  const audioStream = new AudioStream(track, audioSampleRate, audioChannels);
  store.update(recordingId, { _audioStream: audioStream, _hasAudio: true });

  (async () => {
    try {
      for await (const frame of audioStream) {
        const rec = store.get(recordingId);
        if (!rec || !rec._audioProc?.stdin?.writable) break;

        // AudioFrame.data is Int16Array → convert to Buffer (little-endian, matches s16le)
        const buf = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
        const ok = rec._audioProc.stdin.write(buf);
        if (!ok) {
          await new Promise(resolve => rec._audioProc.stdin.once('drain', resolve));
        }
      }
    } catch (err) {
      logger.debug(`[${recordingId}] audio stream ended: ${err.message}`);
    } finally {
      const rec = store.get(recordingId);
      if (rec?._audioProc?.stdin?.writable) rec._audioProc.stdin.end();
    }
  })();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Start recording a single participant.
 * Connects a hidden bot to the room that subscribes to the participant's tracks
 * and pipes the raw frames to FFmpeg for VP9+Opus WebM encoding.
 *
 * @param {string} roomName
 * @param {string} participantIdentity
 * @returns {Promise<string>} recordingId
 */
async function startRecording(roomName, participantIdentity) {
  if (store.getActiveByParticipant(roomName, participantIdentity)) {
    throw new Error(`${participantIdentity} in "${roomName}" is already being recorded`);
  }

  const recordingId = uuidv4();
  const { filename, outputPath, relativeOutput, tmpVideoPath, tmpAudioPath } =
    buildOutputPaths(roomName, participantIdentity, recordingId);

  store.add({
    id:                  recordingId,
    roomName,
    participantIdentity,
    status:              'connecting',
    startTime:           new Date(),
    endTime:             null,
    outputPath,
    relativeOutputPath:  relativeOutput,
    filename,
    error:               null,
    _room:               null,
    _videoProc:          null,
    _audioProc:          null,
    _videoStream:        null,
    _audioStream:        null,
    _tmpVideoPath:       tmpVideoPath,
    _tmpAudioPath:       tmpAudioPath,
    _hasVideo:           false,
    _hasAudio:           false,
  });

  // Connect bot and start streaming in the background
  _runRecordingBot(recordingId, roomName, participantIdentity).catch(err => {
    logger.error(`[${recordingId}] fatal: ${err.message}`);
    store.update(recordingId, { status: 'error', error: err.message, endTime: new Date() });
  });

  return recordingId;
}

async function _runRecordingBot(recordingId, roomName, participantIdentity) {
  const botIdentity = `recorder-${recordingId.slice(0, 8)}`;
  const token = await createRecorderToken(roomName, botIdentity);

  const room = new Room();
  store.update(recordingId, { _room: room });

  room.on(RoomEvent.Disconnected, () => {
    const rec = store.get(recordingId);
    if (rec && rec.status === 'recording') {
      logger.warn(`[${recordingId}] room disconnected unexpectedly – finalising`);
      _finalise(recordingId).catch(err =>
        logger.error(`[${recordingId}] finalise after disconnect: ${err.message}`)
      );
    }
  });

  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (participant.identity !== participantIdentity) return;

    const rec = store.get(recordingId);
    if (!rec || rec.status !== 'recording') return;

    if (track.kind === TrackKind.KIND_VIDEO && !rec._videoProc) {
      logger.info(`[${recordingId}] video track subscribed for ${participantIdentity}`);
      const videoProc = spawnVideoFfmpeg(rec._tmpVideoPath);
      store.update(recordingId, { _videoProc: videoProc });
      pipeVideoToFfmpeg(recordingId, track);
    } else if (track.kind === TrackKind.KIND_AUDIO && !rec._audioProc) {
      logger.info(`[${recordingId}] audio track subscribed for ${participantIdentity}`);
      const audioProc = spawnAudioFfmpeg(rec._tmpAudioPath);
      store.update(recordingId, { _audioProc: audioProc });
      pipeAudioToFfmpeg(recordingId, track);
    }
  });

  await room.connect(config.livekit.url, token, { autoSubscribe: true });
  logger.info(`[${recordingId}] bot connected to room "${roomName}", watching "${participantIdentity}"`);
  store.update(recordingId, { status: 'recording' });

  // Handle tracks that were already published before the bot joined
  for (const [, participant] of room.remoteParticipants) {
    if (participant.identity !== participantIdentity) continue;
    for (const [, publication] of participant.trackPublications) {
      if (!publication.isSubscribed || !publication.track) continue;
      const track = publication.track;
      const rec = store.get(recordingId);
      if (!rec) break;

      if (track.kind === TrackKind.KIND_VIDEO && !rec._videoProc) {
        logger.info(`[${recordingId}] video track already live for ${participantIdentity}`);
        const videoProc = spawnVideoFfmpeg(rec._tmpVideoPath);
        store.update(recordingId, { _videoProc: videoProc });
        pipeVideoToFfmpeg(recordingId, track);
      } else if (track.kind === TrackKind.KIND_AUDIO && !rec._audioProc) {
        logger.info(`[${recordingId}] audio track already live for ${participantIdentity}`);
        const audioProc = spawnAudioFfmpeg(rec._tmpAudioPath);
        store.update(recordingId, { _audioProc: audioProc });
        pipeAudioToFfmpeg(recordingId, track);
      }
    }
  }
}

/**
 * Stop a running recording by ID and produce the final WebM file.
 * @param {string} recordingId
 */
async function stopRecording(recordingId) {
  const rec = store.get(recordingId);
  if (!rec) throw new Error(`Recording ${recordingId} not found`);
  if (rec.status !== 'recording' && rec.status !== 'connecting') {
    throw new Error(`Recording ${recordingId} is not active (status: ${rec.status})`);
  }

  store.update(recordingId, { status: 'stopping' });
  await _finalise(recordingId);
}

async function _finalise(recordingId) {
  const rec = store.get(recordingId);
  if (!rec) return;

  // 1. Close the async streams (interrupts for-await loops)
  try { rec._videoStream?.close(); } catch (_) {}
  try { rec._audioStream?.close(); } catch (_) {}

  // 2. End FFmpeg stdin pipes (in case streams haven't ended them yet)
  if (rec._videoProc?.stdin?.writable) rec._videoProc.stdin.end();
  if (rec._audioProc?.stdin?.writable) rec._audioProc.stdin.end();

  // 3. Disconnect room bot
  try { await rec._room?.disconnect(); } catch (_) {}

  // 4. Wait for FFmpeg processes to finish writing
  await Promise.allSettled([
    rec._videoProc ? waitForProcess(rec._videoProc) : Promise.resolve(),
    rec._audioProc ? waitForProcess(rec._audioProc) : Promise.resolve(),
  ]);

  store.update(recordingId, { status: 'merging' });
  logger.info(`[${recordingId}] merging into ${rec.outputPath}`);

  try {
    await mergeWebm(rec);
    cleanupTmp(rec._tmpVideoPath, rec._tmpAudioPath);
    store.update(recordingId, { status: 'completed', endTime: new Date() });
    logger.info(`[${recordingId}] completed → ${rec.relativeOutputPath}`);
  } catch (err) {
    store.update(recordingId, { status: 'error', error: err.message, endTime: new Date() });
    logger.error(`[${recordingId}] merge failed: ${err.message}`);
    throw err;
  }
}

/**
 * Stop all active recordings in a room.
 * @param {string} roomName
 * @returns {Promise<string[]>} stopped recording IDs
 */
async function stopRoomRecordings(roomName) {
  const active = store.getActiveByRoom(roomName);
  if (active.length === 0) throw new Error(`No active recordings in room "${roomName}"`);

  await Promise.allSettled(active.map(rec => stopRecording(rec.id)));
  return active.map(r => r.id);
}

module.exports = { startRecording, stopRecording, stopRoomRecordings };
