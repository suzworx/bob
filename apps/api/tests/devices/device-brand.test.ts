// Bob-brand devices: the Waveshare round board is named by its hello `board`
// (stored as fw_board) or by its pair_request `model`. A device paired by older
// firmware keeps "M5Stack Cardputer" as its model, so the board alone must do.
import { describe, expect, it } from 'vitest';
import { deviceModelLabel, isBobDevice, modelForBoard } from '../../src/devices/settings.ts';

const cardputer = { model: 'M5Stack Cardputer', board: 'cardputer' };
const waveshareByModel = { model: 'Waveshare ESP32-S3 Round', board: null };
const waveshareByBoard = { model: 'M5Stack Cardputer', board: 'waveshare-s3-185c' };

describe('Bob-brand devices', () => {
  it('knows the Waveshare board by its hello board or its paired model', () => {
    expect([cardputer, waveshareByModel, waveshareByBoard, { model: 'M5Stack Cardputer', board: null }].map(isBobDevice))
      .toEqual([false, true, true, false]);
  });

  it('lists a Waveshare device as Bob and keeps every other model as paired', () => {
    expect(deviceModelLabel(waveshareByBoard)).toBe('Bob (Waveshare 1.85C)');
    expect(deviceModelLabel(waveshareByModel)).toBe('Bob (Waveshare 1.85C)');
    expect(deviceModelLabel(cardputer)).toBe('M5Stack Cardputer');
  });

  it('names the model only for a Waveshare hello board, so other boards keep their paired model', () => {
    expect(modelForBoard('waveshare-s3-185c')).toBe('Bob (Waveshare 1.85C)');
    expect([modelForBoard('cardputer'), modelForBoard(undefined)]).toEqual([null, null]);
  });
});
