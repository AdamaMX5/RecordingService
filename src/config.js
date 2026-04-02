'use strict';

require('dotenv').config();
const path = require('path');

const QUALITY_PRESETS = {
  low:    { videoWidth: 640,  videoHeight: 360,  videoBitrate: '500k',  audioBitrate: '64k',  fps: 15 },
  medium: { videoWidth: 1280, videoHeight: 720,  videoBitrate: '1500k', audioBitrate: '128k', fps: 30 },
  high:   { videoWidth: 1920, videoHeight: 1080, videoBitrate: '4000k', audioBitrate: '192k', fps: 30 },
};

const quality = QUALITY_PRESETS[process.env.RECORDING_QUALITY] || QUALITY_PRESETS.medium;

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,

  livekit: {
    url:       process.env.LIVEKIT_URL       || 'ws://localhost:7880',
    apiKey:    process.env.LIVEKIT_API_KEY   || 'devkey',
    apiSecret: process.env.LIVEKIT_API_SECRET || 'secret',
  },

  recordingsDir: path.resolve(process.env.RECORDINGS_DIR || './recordings'),

  recording: {
    ...quality,
    audioSampleRate: 48000,
    audioChannels:   1,
    // VP9 real-time encoding flags
    cpuUsed: 4,
    deadline: 'realtime',
  },

  logLevel: process.env.LOG_LEVEL || 'info',
};
