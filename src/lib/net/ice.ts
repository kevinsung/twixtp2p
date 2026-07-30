/**
 * WebRTC configuration.
 *
 * STUN only, deliberately. STUN servers merely tell a browser how it looks from
 * the outside; they never carry game traffic. A TURN server would relay traffic
 * and so cannot be serverless, which is why none is configured.
 *
 * The consequence, stated plainly because the UI has to say it: when both peers
 * sit behind symmetric NAT — roughly one pairing in ten — no direct route
 * exists and the connection will fail. Switching one player to a different
 * network or a phone hotspot is the only fix from here.
 */

export const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

export const rtcConfig: RTCConfiguration = {
  iceServers: [{ urls: STUN_SERVERS }],
};

export const NAT_FAILURE_ADVICE =
  'No direct route could be found between the two networks. This happens with ' +
  'some strict NATs and cannot be fixed from inside the app, because working ' +
  'around it needs a relay server. Try again with one player on a different ' +
  'network — a phone hotspot usually works.';
