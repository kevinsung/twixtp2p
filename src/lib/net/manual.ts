/**
 * The fallback connection path: a hand-carried WebRTC handshake.
 *
 * No relay, no library, no third party beyond a public STUN server. The host
 * produces a join link, sends it over any chat app, and the guest sends back a
 * short answer code. Slower than room codes, but it keeps working when public
 * relays are blocked or unreachable.
 *
 * Two details make it practical:
 *
 *  - **Non-trickle ICE.** There is no side channel for late candidates, so we
 *    wait for gathering to finish and ship one self-contained blob.
 *  - **Compression, not templating.** The whole SDP is deflated and base64url'd.
 *    Hand-reducing SDP to its handful of varying fields would give far shorter
 *    codes, but it breaks whenever a browser changes its SDP shape; a few
 *    hundred extra characters is the right trade for a fallback that has to
 *    work when everything else has failed.
 *
 * This path shares WebRTC and STUN with the relay path, so it is *not* a remedy
 * for a NAT that blocks direct connections — it fails there in exactly the same
 * way. It rescues relay outages, nothing more.
 */

import { NAT_FAILURE_ADVICE, rtcConfig } from './ice';
import type { Transport } from './session';

const CHANNEL_LABEL = 'twixt';
const ICE_TIMEOUT_MS = 5000;

interface Envelope {
  /** 'o' for an offer, 'a' for an answer. */
  t: 'o' | 'a';
  s: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function packDescription(envelope: Envelope): Promise<string> {
  const stream = new Blob([JSON.stringify(envelope)])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return toBase64Url(new Uint8Array(buffer));
}

export async function unpackDescription(code: string): Promise<Envelope | null> {
  try {
    const bytes = fromBase64Url(code.trim());
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    const text = await new Response(stream).text();
    const data = JSON.parse(text) as Record<string, unknown>;
    if ((data.t !== 'o' && data.t !== 'a') || typeof data.s !== 'string') return null;
    return { t: data.t, s: data.s };
  } catch {
    return null;
  }
}

/** Resolve once ICE gathering finishes, or give up and use what we have. */
function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = (): void => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    // A blocked or slow STUN server must not hang the handshake forever; the
    // candidates gathered so far are often enough.
    const timer = setTimeout(finish, ICE_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export class ManualTransport implements Transport {
  onMessage: ((data: string) => void) | null = null;
  onOpen: (() => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;

  private closed = false;
  private started = false;
  private opened = false;

  constructor(
    private readonly pc: RTCPeerConnection,
    private channel: RTCDataChannel | null,
  ) {
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') {
        this.onClose?.(NAT_FAILURE_ADVICE);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        if (!this.closed) this.onClose?.('The connection to your opponent dropped.');
      }
    });
    if (channel) this.bind(channel);
  }

  /** Used by the answering side, whose channel arrives with the offer. */
  attach(channel: RTCDataChannel): void {
    this.channel = channel;
    this.bind(channel);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.opened) this.onOpen?.();
  }

  private bind(channel: RTCDataChannel): void {
    channel.addEventListener('open', () => this.markOpen());
    channel.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') this.onMessage?.(event.data);
    });
    channel.addEventListener('close', () => {
      if (!this.closed) this.onClose?.('The connection to your opponent closed.');
    });

    // The channel may already be open by the time we bind to it.
    if (channel.readyState === 'open') this.markOpen();
  }

  private markOpen(): void {
    this.opened = true;
    // Hold the notification until `start` confirms a session is listening.
    if (this.started) this.onOpen?.();
  }

  send(data: string): void {
    if (this.closed || this.channel?.readyState !== 'open') return;
    this.channel.send(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel?.close();
    this.pc.close();
  }
}

export interface ManualOffer {
  /** The blob the host shares, small enough to sit in a URL fragment. */
  code: string;
  transport: ManualTransport;
  /** Feed back the guest's answer code to complete the connection. */
  acceptAnswer(answerCode: string): Promise<boolean>;
}

/** Host side: produce an offer and wait for the answer to come back by hand. */
export async function createManualOffer(): Promise<ManualOffer> {
  const pc = new RTCPeerConnection(rtcConfig);
  const channel = pc.createDataChannel(CHANNEL_LABEL);
  const transport = new ManualTransport(pc, channel);

  await pc.setLocalDescription(await pc.createOffer());
  await waitForIce(pc);

  const code = await packDescription({ t: 'o', s: pc.localDescription?.sdp ?? '' });

  return {
    code,
    transport,
    async acceptAnswer(answerCode: string): Promise<boolean> {
      const envelope = await unpackDescription(answerCode);
      if (!envelope || envelope.t !== 'a') return false;
      await pc.setRemoteDescription({ type: 'answer', sdp: envelope.s });
      return true;
    },
  };
}

export interface ManualAnswer {
  /** The blob the guest sends back to the host. */
  code: string;
  transport: ManualTransport;
}

/** Guest side: take the host's offer and produce an answer. */
export async function answerManualOffer(offerCode: string): Promise<ManualAnswer | null> {
  const envelope = await unpackDescription(offerCode);
  if (!envelope || envelope.t !== 'o') return null;

  const pc = new RTCPeerConnection(rtcConfig);
  const transport = new ManualTransport(pc, null);
  pc.addEventListener('datachannel', (event: RTCDataChannelEvent) => {
    transport.attach(event.channel);
  });

  await pc.setRemoteDescription({ type: 'offer', sdp: envelope.s });
  await pc.setLocalDescription(await pc.createAnswer());
  await waitForIce(pc);

  return {
    code: await packDescription({ t: 'a', s: pc.localDescription?.sdp ?? '' }),
    transport,
  };
}
