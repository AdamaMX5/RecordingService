'use strict';

require('dotenv').config();
const express = require('express');
const config  = require('./config');
const logger  = require('./logger');
const apiRouter = require('./routes/index');

const app = express();
app.use(express.json());

app.use(apiRouter);

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
