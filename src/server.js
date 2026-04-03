'use strict';

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const config  = require('./config');
const logger  = require('./logger');
const apiRouter = require('./routes/index');

function getCorsSettings() {
  const originsRaw = process.env.CORS_ORIGINS || '';
  const origins = originsRaw
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    logger.warn('CORS_ORIGINS is not set — all origins will be blocked by CORS policy');
  }

  const methodsRaw  = process.env.CORS_METHODS  || '*';
  const headersRaw  = process.env.CORS_HEADERS  || '*';
  const credentials = (process.env.CORS_ALLOW_CREDENTIALS || 'true') === 'true';

  return {
    origin:      origins.length > 0 ? origins : false,
    methods:     methodsRaw  === '*' ? methodsRaw  : methodsRaw.split(',').map(m => m.trim()),
    allowedHeaders: headersRaw === '*' ? headersRaw : headersRaw.split(',').map(h => h.trim()),
    credentials,
  };
}

const app = express();

app.use(cors(getCorsSettings()));
app.use(express.json());

// API routes
app.use('/api', apiRouter);

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler
app.use((err, _req, res, _next) => {
  logger.error(err.message);
  const status = err.statusCode || err.status || 500;
  res.status(status).json({ error: err.message });
});

app.listen(config.port, () => {
  logger.info(`Recording service listening on port ${config.port}`);
  logger.info(`LiveKit URL : ${config.livekit.url}`);
  logger.info(`Recordings  : ${config.recordingsDir}`);
});

module.exports = app;
