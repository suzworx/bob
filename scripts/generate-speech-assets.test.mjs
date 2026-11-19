import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const generator = join(dirname(fileURLToPath(import.meta.url)), 'generate-speech-assets.mjs');
let directory;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bob-speech-assets-'));
  mkdirSync(join(directory, 'pack'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function runGenerator(spec, options = {}) {
  const specPath = join(directory, 'spec.json');
  writeFileSync(specPath, JSON.stringify(spec));
  return spawnSync(process.execPath, [generator, '--dir', join(directory, 'pack'), '--spec', specPath, ...(options.write ? ['--write'] : [])], {
    encoding: 'utf8',
  });
}

function specWithClip(file = 'clip.pcm') {
  writeFileSync(join(directory, 'pack', file), Buffer.alloc(32));
  return {
    buildVersion: 'build-1', model: 'model', voice: 'voice', locale: 'en-US',
    clips: [{ id: 'clip', file: `pack/${file}` }],
    templates: [{ id: 'hello', segments: [{ type: 'literal', text: 'Hello', clipId: 'clip' }] }],
  };
}

describe('speech asset generator manifest compatibility', () => {
  it('emits a valid small manifest', () => {
    const result = runGenerator(specWithClip());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.parse(result.stdout).clips[0]).toMatchObject({
      path: 'clip.pcm',
      bytes: 32,
      durationMs: 1,
    });
  });

  it.each([false, true])('rejects a manifest above 64 KiB before output (write=%s)', (write) => {
    const spec = specWithClip();
    spec.templates = Array.from({ length: 64 }, (_, template) => ({
      id: `template_${template}`,
      segments: [{
        type: 'slot',
        values: Array.from({ length: 4 }, (_, value) => ({
          text: `${template}_${value}_${'x'.repeat(190)}`,
          clipId: 'clip',
        })),
      }],
    }));
    const manifestPath = join(directory, 'pack', 'manifest.json');
    writeFileSync(manifestPath, 'previous manifest\n');

    const result = runGenerator(spec, { write });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Manifest exceeds 64 KiB');
    expect(readFileSync(manifestPath, 'utf8')).toBe('previous manifest\n');
  });

  it('rejects a two-byte clip whose rounded duration is zero', () => {
    const spec = specWithClip();
    writeFileSync(join(directory, 'pack', 'clip.pcm'), Buffer.alloc(2));

    const result = runGenerator(spec);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('duration');
  });

  it('rejects a clip path longer than the manifest schema permits', () => {
    const spec = specWithClip(`${'a'.repeat(177)}.pcm`);

    const result = runGenerator(spec);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('path');
  });

  it('refuses responses that differ only by apostrophe style, as the server would', () => {
    const spec = specWithClip();
    spec.templates = [{ id: 'twins', segments: [{ type: 'slot', values: [
      { text: "I've set it.", clipId: 'clip' }, { text: 'I’ve set it.', clipId: 'clip' },
    ] }] }];
    const result = runGenerator(spec);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ambiguous/);
  });

  it('accepts a template whose first segment alone equals another response', () => {
    const spec = specWithClip();
    spec.templates = [
      { id: 'ack', segments: [{ type: 'literal', text: 'OK.', clipId: 'clip' }] },
      { id: 'ack-done', segments: [{ type: 'literal', text: 'OK.', clipId: 'clip' }, { type: 'literal', text: ' Done.', clipId: 'clip' }] },
    ];
    const result = runGenerator(spec);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
