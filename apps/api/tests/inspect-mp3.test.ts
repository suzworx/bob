// Regression tests for the MP3 header inspector. Its duration output is the
// reference the on-device playback span is scored against, so a parsing error
// here is expensive: an inverted layer bit-field previously priced Layer III
// frames off the Layer I bitrate table and reported audio.mp3 as 160 kbps,
// making a correct 3.72 s playback look 5.6x too slow.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseFile } from 'music-metadata';

// @ts-expect-error - dependency-free diagnostic script, no type declarations.
import { inspectMp3, parseFrame } from '../scripts/inspect-mp3.mjs';

/**
 * Builds a 4-byte MPEG audio frame header.
 * layerBits counts down: 0b11 = Layer I, 0b10 = Layer II, 0b01 = Layer III.
 */
function header(opts: {
  versionBits: number;
  layerBits: number;
  bitrateIdx: number;
  sampleRateIdx: number;
  padding?: number;
  channelBits?: number;
}): Buffer {
  const h =
    (0x7ff << 21) |
    (opts.versionBits << 19) |
    (opts.layerBits << 17) |
    (1 << 16) | // protection absent
    (opts.bitrateIdx << 12) |
    (opts.sampleRateIdx << 10) |
    ((opts.padding ?? 0) << 9) |
    ((opts.channelBits ?? 3) << 6);
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(h >>> 0, 0);
  return buf;
}

describe('parseFrame', () => {
  it('maps the layer bit-field to the right layer, not its inverse', () => {
    const layerIII = parseFrame(
      header({ versionBits: 3, layerBits: 0b01, bitrateIdx: 5, sampleRateIdx: 1 }),
      0,
    );
    const layerI = parseFrame(
      header({ versionBits: 3, layerBits: 0b11, bitrateIdx: 5, sampleRateIdx: 1 }),
      0,
    );

    expect(layerIII.layer).toBe('III');
    expect(layerI.layer).toBe('I');
  });

  it('prices each layer off its own bitrate table', () => {
    // Index 5 is 64 kbps in the MPEG1 Layer III table but 160 kbps in Layer I.
    // Reading the wrong table is exactly the bug that inflated audio.mp3.
    const layerIII = parseFrame(
      header({ versionBits: 3, layerBits: 0b01, bitrateIdx: 5, sampleRateIdx: 1 }),
      0,
    );
    const layerI = parseFrame(
      header({ versionBits: 3, layerBits: 0b11, bitrateIdx: 5, sampleRateIdx: 1 }),
      0,
    );

    expect(layerIII.bitrateKbps).toBe(64);
    expect(layerI.bitrateKbps).toBe(160);
  });

  it('derives samples-per-frame and frame length per layer', () => {
    const layerIII = parseFrame(
      header({ versionBits: 3, layerBits: 0b01, bitrateIdx: 5, sampleRateIdx: 1 }),
      0,
    );
    expect(layerIII.samplesPerFrame).toBe(1152);
    expect(layerIII.frameLen).toBe(192); // 144 * 64000 / 48000

    // MPEG2 Layer III halves to 576 samples per frame.
    const mpeg2 = parseFrame(
      header({ versionBits: 2, layerBits: 0b01, bitrateIdx: 5, sampleRateIdx: 0 }),
      0,
    );
    expect(mpeg2.samplesPerFrame).toBe(576);

    const layerI = parseFrame(
      header({ versionBits: 3, layerBits: 0b11, bitrateIdx: 5, sampleRateIdx: 1 }),
      0,
    );
    expect(layerI.samplesPerFrame).toBe(384);
  });

  it('computes Layer I frame length with its own *4 formula', () => {
    // Layer I is (12 * bitrate / rate + padding) * 4, not the 144-byte form.
    // Only samplesPerFrame was asserted before, so the length was untested.
    const layerI = parseFrame(
      header({ versionBits: 3, layerBits: 0b11, bitrateIdx: 5, sampleRateIdx: 1 }),
      0,
    );
    expect(layerI.frameLen).toBe(160); // (12 * 160000 / 48000) * 4

    const padded = parseFrame(
      header({ versionBits: 3, layerBits: 0b11, bitrateIdx: 5, sampleRateIdx: 1, padding: 1 }),
      0,
    );
    expect(padded.frameLen).toBe(164); // padding adds a whole 4-byte slot
  });

  it('adds a single byte of padding on Layer II and III', () => {
    const padded = parseFrame(
      header({ versionBits: 3, layerBits: 0b01, bitrateIdx: 5, sampleRateIdx: 1, padding: 1 }),
      0,
    );
    expect(padded.frameLen).toBe(193); // 192 + 1

    const layerII = parseFrame(
      header({ versionBits: 3, layerBits: 0b10, bitrateIdx: 5, sampleRateIdx: 1 }),
      0,
    );
    expect(layerII.layer).toBe('II');
    expect(layerII.samplesPerFrame).toBe(1152);
    expect(layerII.bitrateKbps).toBe(80); // MPEG1 Layer II table, index 5
  });

  it('parses MPEG2 and MPEG2.5 rates and frame lengths', () => {
    const mpeg2 = parseFrame(
      header({ versionBits: 2, layerBits: 0b01, bitrateIdx: 5, sampleRateIdx: 0 }),
      0,
    );
    expect(mpeg2.version).toBe('MPEG2');
    expect(mpeg2.sampleRate).toBe(22050);
    expect(mpeg2.bitrateKbps).toBe(40); // MPEG2 Layer III table, index 5
    expect(mpeg2.frameLen).toBe(130); // floor(576/8 * 40000 / 22050)

    const mpeg25 = parseFrame(
      header({ versionBits: 0, layerBits: 0b01, bitrateIdx: 5, sampleRateIdx: 0 }),
      0,
    );
    expect(mpeg25.version).toBe('MPEG2.5');
    expect(mpeg25.sampleRate).toBe(11025);
    expect(mpeg25.samplesPerFrame).toBe(576);
  });

  it('rejects reserved version, layer and bitrate encodings', () => {
    const reservedVersion = header({ versionBits: 1, layerBits: 0b01, bitrateIdx: 5, sampleRateIdx: 1 });
    const reservedLayer = header({ versionBits: 3, layerBits: 0b00, bitrateIdx: 5, sampleRateIdx: 1 });
    const freeBitrate = header({ versionBits: 3, layerBits: 0b01, bitrateIdx: 0, sampleRateIdx: 1 });
    const badBitrate = header({ versionBits: 3, layerBits: 0b01, bitrateIdx: 15, sampleRateIdx: 1 });
    const badRate = header({ versionBits: 3, layerBits: 0b01, bitrateIdx: 5, sampleRateIdx: 3 });

    for (const buf of [reservedVersion, reservedLayer, freeBitrate, badBitrate, badRate]) {
      expect(parseFrame(buf, 0)).toBeNull();
    }
  });
});

describe('inspectMp3', () => {
  it('skips an ID3v2 tag instead of false-syncing inside it', () => {
    // The tag body embeds a genuinely decodable frame header, so a scanner
    // starting at offset 0 really would sync inside the tag. A body of plain
    // 0xFF would not: its bitrate index is 15, which parseFrame rejects, so
    // the skip could be deleted and the test would still pass.
    const decoyHeader = header({
      versionBits: 3, layerBits: 0b01, bitrateIdx: 9, sampleRateIdx: 0,
    });
    // Body >127 bytes so the syncsafe size exercises more than its low byte;
    // swapping the <<21/<<14/<<7 shifts must fail this test.
    const tagBody = Buffer.concat([decoyHeader, Buffer.alloc(196, 0x00)]);
    const size = tagBody.length; // 200 -> syncsafe [0, 0, 1, 72]
    const tag = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([0x03, 0x00, 0x00]),
      Buffer.from([
        (size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f,
      ]),
      tagBody,
    ]);
    const frame = Buffer.concat([
      header({ versionBits: 3, layerBits: 0b01, bitrateIdx: 5, sampleRateIdx: 1 }),
      Buffer.alloc(188),
    ]);

    const result = inspectMp3(Buffer.concat([tag, frame]));

    expect(result.frames).toHaveLength(1);
    expect(result.resyncBytes).toBe(0);
    expect(result.frames[0].off).toBe(tag.length);
  });

  it('excludes a Xing/Info header frame from the audio totals', () => {
    // A Xing/Info frame carries stream metadata, not audio, and every decoder
    // skips it. Counting its 1152 samples made a device that decoded the
    // stream exactly look like it was dropping a frame.
    const audioFrame = Buffer.concat([
      header({ versionBits: 3, layerBits: 0b01, bitrateIdx: 5, sampleRateIdx: 1 }),
      Buffer.alloc(188),
    ]);
    const infoFrame = Buffer.concat([
      header({ versionBits: 3, layerBits: 0b01, bitrateIdx: 5, sampleRateIdx: 1 }),
      Buffer.alloc(17),
      Buffer.from('Info', 'latin1'),
      Buffer.alloc(167),
    ]);

    const result = inspectMp3(Buffer.concat([infoFrame, audioFrame, audioFrame]));

    expect(result.frames).toHaveLength(3);
    expect(result.headerFrames).toBe(1);
    expect(result.audioFrames).toBe(2);
    expect(result.samples).toBe(2 * 1152); // the Info frame contributes none
  });

  it('reports the format and duration of a device-test-shaped stream', () => {
    // Mirrors the on-device downlink fixture (audio.mp3): 155 MPEG1 Layer III
    // frames at 64 kbps / 48 kHz, 192 bytes each. Synthesized rather than read
    // from disk because *.mp3 is git-ignored — reading the real file made this
    // test pass only on a machine that happened to have it, and ENOENT on a
    // fresh clone would fail `npm run validate`, the mandatory delivery gate.
    const frame = Buffer.concat([
      header({ versionBits: 3, layerBits: 0b01, bitrateIdx: 5, sampleRateIdx: 1 }),
      Buffer.alloc(188),
    ]);
    const stream = Buffer.concat(Array.from({ length: 155 }, () => frame));

    const result = inspectMp3(stream);

    expect(result.frames).toHaveLength(155);
    expect(result.samples).toBe(178560);
    expect(result.durationMs).toBe(3720);
    expect(result.resyncBytes).toBe(0);

    const formats = new Set(
      result.frames.map((f: { bitrateKbps: number; sampleRate: number; layer: string }) =>
        `${f.layer}/${f.bitrateKbps}/${f.sampleRate}`),
    );
    expect([...formats]).toEqual(['III/64/48000']);
  });

  it('runs as a CLI and prints a summary', () => {
    // The entrypoint was the one untested surface, which is exactly why a
    // broken `file://` comparison shipped: on Windows it never matched, so
    // the command produced no output and still exited 0.
    const script = resolve(__dirname, '../scripts/inspect-mp3.mjs');
    const fixture = resolve(tmpdir(), `inspect-mp3-cli-${process.pid}.mp3`);
    const frame = Buffer.concat([
      header({ versionBits: 3, layerBits: 0b01, bitrateIdx: 5, sampleRateIdx: 1 }),
      Buffer.alloc(188),
    ]);
    writeFileSync(fixture, Buffer.concat([frame, frame]));

    try {
      const out = execFileSync(process.execPath, [script, fixture], { encoding: 'utf8' });
      expect(out).toContain('frames=2');
      expect(out).toContain('2x MPEG1/III 64kbps 48000Hz mono');
      expect(out).toContain('duration_ms=48');
    } finally {
      rmSync(fixture, { force: true });
    }
    // This spawns a real `node` process. On Windows that alone costs a second or
    // two, and under a full parallel suite it crossed the 5 s default (5.4 s)
    // while passing 13/13 in isolation, three runs out of three. The limit was
    // measuring machine load, not the CLI.
  }, 20_000);

  it('matches the real device-test asset when it is present', () => {
    // Opportunistic: audio.mp3 is git-ignored, so this only runs where the
    // harness fixture actually exists. It is the check that the synthesized
    // expectation above still describes the file the device is streamed.
    const assetPath = resolve(__dirname, '../../../audio.mp3');
    if (!existsSync(assetPath)) return;

    const result = inspectMp3(readFileSync(assetPath));

    expect(result.frames).toHaveLength(155);
    expect(result.audioFrames).toBe(154); // one Xing/Info header frame
    expect(result.samples).toBe(177408);
    expect(result.durationMs).toBe(3696);
    expect(result.resyncBytes).toBe(0);
  });

  it('agrees with an independent parser on the real asset', async () => {
    // Cross-check against a maintained library. Our hand-rolled parser is the
    // one that inverted the layer bit-field and over-counted the Info frame —
    // both bugs sent firmware debugging after faults that did not exist. This
    // catches that whole class by disagreeing loudly.
    const assetPath = resolve(__dirname, '../../../audio.mp3');
    if (!existsSync(assetPath)) return;

    const ours = inspectMp3(readFileSync(assetPath));
    const theirs = await parseFile(assetPath, { duration: true });

    expect(theirs.format.numberOfSamples).toBe(ours.samples + 1152); // incl. Info frame
    expect(Math.round((theirs.format.duration ?? 0) * 1000)).toBe(ours.durationMs);
    expect(theirs.format.sampleRate).toBe(ours.frames[0].sampleRate);
    expect((theirs.format.bitrate ?? 0) / 1000).toBe(ours.frames[0].bitrateKbps);
    expect(theirs.format.codec).toBe('MPEG 1 Layer 3');
  });
});
