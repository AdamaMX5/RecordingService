'use strict';

const { Router } = require('express');
const fs   = require('fs');
const path = require('path');
const { listRooms, listParticipants } = require('../services/livekitService');
const { startRecording, stopRecording, stopRoomRecordings } = require('../services/recorderService');
const store  = require('../store/recordingStore');
const config = require('../config');

/** Return all .webm files for a room, sorted newest-first. */
function getRoomVideos(roomName) {
  const safe    = roomName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const roomDir = path.join(config.recordingsDir, safe);
  if (!fs.existsSync(roomDir)) return [];

  const results = [];
  for (const dateDirent of fs.readdirSync(roomDir, { withFileTypes: true })) {
    if (!dateDirent.isDirectory() || dateDirent.name.startsWith('.')) continue;
    const dateDir = path.join(roomDir, dateDirent.name);
    for (const fileDirent of fs.readdirSync(dateDir, { withFileTypes: true })) {
      if (!fileDirent.isFile() || !fileDirent.name.endsWith('.webm') || fileDirent.name.startsWith('.')) continue;
      const filePath = path.join(dateDir, fileDirent.name);
      const stat     = fs.statSync(filePath);
      results.push({ filename: fileDirent.name, date: dateDirent.name, filePath, size: stat.size, created: stat.birthtime });
    }
  }
  return results.sort((a, b) => b.created - a.created);
}

const router = Router();

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * GET /api/rooms
 * List all active LiveKit rooms.
 */
router.get('/', async (_req, res, next) => {
  try {
    const rooms = await listRooms();
    res.json({
      rooms: rooms.map(r => ({
        name:            r.name,
        numParticipants: r.numParticipants,
        createdAt:       r.creationTime ? new Date(Number(r.creationTime) * 1000) : null,
        metadata:        r.metadata || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/rooms/:roomName/participants
 * List all participants currently in a room.
 */
router.get('/:roomName/participants', async (req, res, next) => {
  try {
    const participants = await listParticipants(req.params.roomName);
    res.json({
      roomName: req.params.roomName,
      participants: participants.map(p => ({
        identity:    p.identity,
        name:        p.name || null,
        joinedAt:    p.joinedAt ? new Date(Number(p.joinedAt) * 1000) : null,
        isPublisher: p.isPublisher,
        metadata:    p.metadata || null,
        tracks:      (p.tracks || []).map(t => ({
          sid:   t.sid,
          type:  t.type,
          name:  t.name,
          muted: t.muted,
        })),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Room-level recording controls ───────────────────────────────────────────

/**
 * POST /api/rooms/:roomName/record
 * Start recording participants in a room.
 *
 * Body (all fields optional):
 *   { "participants": ["alice", "bob"] }
 *   Omit "participants" to auto-discover and record everyone in the room.
 *
 * Returns 202 with { started: [...], skipped: [...] }.
 */
router.post('/:roomName/record', async (req, res, next) => {
  try {
    const { roomName } = req.params;
    let identities = Array.isArray(req.body?.participants) ? req.body.participants : null;

    if (!identities || identities.length === 0) {
      const participants = await listParticipants(roomName);
      identities = participants.map(p => p.identity);
      if (identities.length === 0) {
        return res.status(422).json({ error: `No participants found in room "${roomName}"` });
      }
    }

    const results = await Promise.allSettled(
      identities.map(identity => startRecording(roomName, identity))
    );

    const started = [];
    const skipped = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        started.push(store.toPublic(store.get(r.value)));
      } else {
        skipped.push({ identity: identities[i], reason: r.reason?.message });
      }
    });

    res.status(202).json({ started, skipped });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/rooms/:roomName/record
 * Stop all active recordings in a room and finalize all files.
 */
router.delete('/:roomName/record', async (req, res, next) => {
  try {
    const ids = await stopRoomRecordings(req.params.roomName);
    res.json({ stopped: ids });
  } catch (err) {
    next(err);
  }
});

// ─── Participant-level recording controls ─────────────────────────────────────

/**
 * POST /api/rooms/:roomName/participants/:identity/record
 * Start recording a single participant.
 */
router.post('/:roomName/participants/:identity/record', async (req, res, next) => {
  try {
    const { roomName, identity } = req.params;
    const id = await startRecording(roomName, identity);
    res.status(202).json(store.toPublic(store.get(id)));
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/rooms/:roomName/participants/:identity/record
 * Stop the active recording for a specific participant.
 */
router.delete('/:roomName/participants/:identity/record', async (req, res, next) => {
  try {
    const { roomName, identity } = req.params;
    const rec = store.getActiveByParticipant(roomName, identity);
    if (!rec) {
      return res.status(404).json({
        error: `No active recording for "${identity}" in room "${roomName}"`,
      });
    }
    await stopRecording(rec.id);
    res.json(store.toPublic(store.get(rec.id)));
  } catch (err) {
    next(err);
  }
});

// ─── Room video discovery & download ─────────────────────────────────────────

/**
 * GET /rooms/:roomName/videos
 * List all completed recording files for a room.
 */
router.get('/:roomName/videos', (req, res) => {
  const videos = getRoomVideos(req.params.roomName);
  res.json({
    roomName: req.params.roomName,
    videos:   videos.map(({ filename, date, size, created }) => ({ filename, date, size, created })),
  });
});

/**
 * GET /rooms/:roomName/videos/latest
 * Stream (or download) the most recent recording for a room.
 * Add ?download=1 to force Content-Disposition: attachment.
 */
router.get('/:roomName/videos/latest', (req, res) => {
  const videos = getRoomVideos(req.params.roomName);
  if (videos.length === 0) return res.status(404).json({ error: 'No recordings found for this room' });

  const { filename, filePath } = videos[0];
  const disposition = req.query.download === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'video/webm');
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.sendFile(filePath);
});

/**
 * GET /rooms/:roomName/videos/:filename
 * Stream (or download) a specific recording by filename.
 * Add ?download=1 to force Content-Disposition: attachment.
 */
router.get('/:roomName/videos/:filename', (req, res) => {
  const { filename } = req.params;
  if (!filename.endsWith('.webm') || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const videos = getRoomVideos(req.params.roomName);
  const found  = videos.find(v => v.filename === filename);
  if (!found) return res.status(404).json({ error: 'File not found' });

  const disposition = req.query.download === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'video/webm');
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.sendFile(found.filePath);
});

module.exports = router;
