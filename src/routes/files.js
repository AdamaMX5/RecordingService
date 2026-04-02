'use strict';

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const router = Router();

/** Recursively collect all .webm files under a directory. */
function collectWebmFiles(dir, base = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;  // skip .tmp and hidden dirs
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectWebmFiles(full, base));
    } else if (entry.isFile() && entry.name.endsWith('.webm')) {
      const stat = fs.statSync(full);
      files.push({
        path:     path.relative(base, full).replace(/\\/g, '/'),
        filename: entry.name,
        size:     stat.size,
        created:  stat.birthtime,
      });
    }
  }
  return files;
}

/**
 * GET /api/files
 * List all completed recording files.
 * Optional query param: ?room=roomName
 */
router.get('/', (req, res) => {
  if (!fs.existsSync(config.recordingsDir)) {
    return res.json({ files: [] });
  }

  let files = collectWebmFiles(config.recordingsDir);

  if (req.query.room) {
    const safe = req.query.room.replace(/[^a-zA-Z0-9._-]/g, '_');
    files = files.filter(f => f.path.startsWith(safe + '/'));
  }

  res.json({ files });
});

/**
 * GET /api/files/:roomName/:date/:filename
 * Download a specific recording file.
 *
 * Add ?download=1 to force Content-Disposition: attachment.
 */
router.get('/:roomName/:date/:filename', (req, res) => {
  const { roomName, date, filename } = req.params;

  // Basic path traversal protection
  if ([roomName, date, filename].some(p => p.includes('..') || p.includes('/') || p.includes('\\'))) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  if (!filename.endsWith('.webm')) {
    return res.status(400).json({ error: 'Only .webm files are served here' });
  }

  const filePath = path.join(config.recordingsDir, roomName, date, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const forceDownload = req.query.download === '1';
  res.setHeader('Content-Type', 'video/webm');
  if (forceDownload) {
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  } else {
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  }

  res.sendFile(filePath);
});

module.exports = router;
