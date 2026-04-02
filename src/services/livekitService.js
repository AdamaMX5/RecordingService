'use strict';

const { RoomServiceClient, AccessToken } = require('livekit-server-sdk');
const config = require('../config');

const roomService = new RoomServiceClient(
  config.livekit.url,
  config.livekit.apiKey,
  config.livekit.apiSecret
);

/**
 * List all active rooms on the LiveKit server.
 * @returns {Promise<import('livekit-server-sdk').Room[]>}
 */
async function listRooms() {
  return roomService.listRooms();
}

/**
 * List all participants currently in a room.
 * @param {string} roomName
 * @returns {Promise<import('livekit-server-sdk').ParticipantInfo[]>}
 */
async function listParticipants(roomName) {
  return roomService.listParticipants(roomName);
}

/**
 * Create a short-lived access token for a recording bot participant.
 * The bot is hidden (not shown in participant lists) and can only subscribe.
 *
 * @param {string} roomName
 * @param {string} botIdentity
 * @returns {Promise<string>} JWT token
 */
async function createRecorderToken(roomName, botIdentity) {
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: botIdentity,
    name: 'Recorder',
    ttl: '4h',
  });

  at.addGrant({
    roomJoin:     true,
    room:         roomName,
    canSubscribe: true,
    canPublish:   false,
    hidden:       true,
  });

  return at.toJwt();
}

module.exports = { listRooms, listParticipants, createRecorderToken };
