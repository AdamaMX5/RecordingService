'use strict';

const { Router } = require('express');
const { startRecording, stopRecording } = require('../services/recorderService');
const store = require('../store/recordingStore');

const router = Router();

/**
 * GET /api/recordings
 * List all known recordings (active + completed).
 * Optional query params: ?room=name  ?status=recording|completed|error
 */
router.get('/', (req, res) => {
  const { status, room } = req.query;
  let recordings = store.getAll();

  if (room)   recordings = recordings.filter(r => r.roomName === room);
  if (status) recordings = recordings.filter(r => r.status === status);

  res.json({ recordings: recordings.map(r => store.toPublic(r)) });
});

/**
 * GET /api/recordings/:id
 * Get a single recording by ID.
 */
router.get('/:id', (req, res) => {
  const rec = store.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Recording not found' });
  res.json(store.toPublic(rec));
});

/**
 * DELETE /api/recordings/:id
 * Stop an active recording by ID and finalize the file.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    await stopRecording(req.params.id);
    res.json(store.toPublic(store.get(req.params.id)));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
