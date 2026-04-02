'use strict';

const { Router } = require('express');
const roomsRouter      = require('./rooms');
const recordingsRouter = require('./recordings');
const filesRouter      = require('./files');
const store            = require('../store/recordingStore');

const router = Router();

/**
 * GET /api/status
 * Quick health check and count of active recordings.
 */
router.get('/status', (_req, res) => {
  const all    = store.getAll();
  const active = all.filter(r => r.status === 'recording' || r.status === 'connecting');
  res.json({
    status:           'ok',
    activeRecordings: active.length,
    totalRecordings:  all.length,
    recordings:       active.map(r => store.toPublic(r)),
  });
});

router.use('/rooms',      roomsRouter);
router.use('/recordings', recordingsRouter);
router.use('/files',      filesRouter);

module.exports = router;
