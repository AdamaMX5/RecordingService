'use strict';

const { Router } = require('express');
const { listRooms, listParticipants } = require('../services/livekitService');
const { startRecording, stopRecording, stopRoomRecordings } = require('../services/recorderService');
const store = require('../store/recordingStore');

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

module.exports = router;
