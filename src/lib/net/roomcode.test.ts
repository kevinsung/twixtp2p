import { describe, expect, it } from 'vitest';

import { packDescription, unpackDescription } from './manual';
import {
  CODE_LENGTH,
  codeFromHash,
  formatCode,
  generateCode,
  isValidCode,
  normalizeCode,
  roomIdFor,
  shareLink,
} from './roomcode';

describe('room codes', () => {
  it('generates codes of the right length from the safe alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      // Crockford base32 excludes the glyphs people misread.
      expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/);
      expect(code).not.toMatch(/[ILOU]/);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateCode());
    expect(seen.size).toBe(500);
  });

  it('forgives the characters the alphabet leaves out', () => {
    // Someone reading "0" aloud and typing "O" should still get into the room.
    expect(normalizeCode('OIL')).toBe('011');
    expect(normalizeCode('4k9m-8hq2')).toBe('4K9M8HQ2');
    expect(normalizeCode('  4K9M 8HQ2  ')).toBe('4K9M8HQ2');
  });

  it('validates length after normalising', () => {
    expect(isValidCode('4k9m-8hq2')).toBe(true);
    expect(isValidCode('4K9M')).toBe(false);
    expect(isValidCode('')).toBe(false);
  });

  it('formats a code in two readable halves', () => {
    expect(formatCode('4K9M8HQ2')).toBe('4K9M-8HQ2');
  });
});

describe('room identifiers', () => {
  it('derives a stable id that does not contain the code', async () => {
    const code = '4K9M8HQ2';
    const id = await roomIdFor(code);

    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(await roomIdFor(code)).toBe(id);
    // The relay must not be able to read the secret off the room id.
    expect(id.toUpperCase()).not.toContain(code);
  });

  it('ignores formatting differences in the code', async () => {
    expect(await roomIdFor('4k9m-8hq2')).toBe(await roomIdFor('4K9M8HQ2'));
  });

  it('gives different codes different rooms', async () => {
    expect(await roomIdFor('4K9M8HQ2')).not.toBe(await roomIdFor('4K9M8HQ3'));
  });
});

describe('share links', () => {
  it('puts the code in the fragment, never the query', () => {
    const link = shareLink('4K9M8HQ2', 'https://example.com/twixt/');
    expect(link).toBe('https://example.com/twixt/#r=4K9M8HQ2');
    expect(new URL(link).search).toBe('');
  });

  it('round-trips through the fragment', () => {
    const link = shareLink('4K9M8HQ2', 'https://example.com/');
    expect(codeFromHash(new URL(link).hash)).toBe('4K9M8HQ2');
  });

  it('returns null when there is no usable code', () => {
    expect(codeFromHash('')).toBeNull();
    expect(codeFromHash('#other=1')).toBeNull();
    expect(codeFromHash('#r=TOOSHORT1234')).toBeNull();
  });
});

describe('manual handshake encoding', () => {
  it('round-trips an SDP blob', async () => {
    const sdp = [
      'v=0',
      'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=group:BUNDLE 0',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'a=ice-ufrag:4ZcD',
      'a=ice-pwd:2/1muCWoOi3uLifh0NuRHlfw',
      'a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89',
    ].join('\r\n');

    const packed = await packDescription({ t: 'o', s: sdp });
    expect(packed).toMatch(/^[A-Za-z0-9_-]+$/); // URL-fragment safe
    expect(await unpackDescription(packed)).toEqual({ t: 'o', s: sdp });
  });

  it('compresses a realistic SDP well enough for a URL', async () => {
    // Real offers repeat a lot of boilerplate, which is why deflating the whole
    // thing is good enough without hand-templating it.
    const sdp = new Array(40)
      .fill('a=candidate:842163049 1 udp 1677729535 203.0.113.7 54321 typ srflx raddr 0.0.0.0')
      .join('\r\n');

    const packed = await packDescription({ t: 'o', s: sdp });
    expect(packed.length).toBeLessThan(sdp.length / 4);
    expect(await unpackDescription(packed)).toEqual({ t: 'o', s: sdp });
  });

  it('returns null for anything that is not a valid blob', async () => {
    expect(await unpackDescription('not-a-real-code')).toBeNull();
    expect(await unpackDescription('')).toBeNull();
    expect(await unpackDescription(await packDescription({ t: 'a', s: 'x' }))).toEqual({
      t: 'a',
      s: 'x',
    });
  });
});
