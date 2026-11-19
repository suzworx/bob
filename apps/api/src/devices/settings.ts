/** Device setting vocabularies shared by the settings store, the tools and the wire. */
import { z } from 'zod';

export const DeviceModeSchema = z.enum(['ptt', 'wake', 'announce_only']);
export type DeviceMode = z.infer<typeof DeviceModeSchema>;

export const RingSoundSchema = z.enum(['classic', 'chime', 'pulse']);
export type RingSound = z.infer<typeof RingSoundSchema>;

/** The phrase the device wakes to: "Hey Bob", the only one (devices.wake_word's check still allows it). */
export const WakeWordSchema = z.enum(['bob']);
export type WakeWord = z.infer<typeof WakeWordSchema>;

// The Waveshare round board is Bob's body: its hello `board` or its paired `model` names it.
const BOB_BOARD = /^waveshare-/i;
const BOB_MODEL = /waveshare/i;
const BOB_MODEL_LABEL = 'Bob (Waveshare 1.85C)';

/** True for a Bob-brand device: a Waveshare board id (hello `board`) or model (pair_request `model`). */
export function isBobDevice(device: { model: string; board: string | null }): boolean {
  return (device.board !== null && BOB_BOARD.test(device.board)) || BOB_MODEL.test(device.model);
}

/** The model a hello board names, or null when the board does not name one (keep the paired model). */
export function modelForBoard(board: string | undefined): string | null {
  return board !== undefined && BOB_BOARD.test(board) ? BOB_MODEL_LABEL : null;
}

/** What the web app lists the device as: Bob's board gets Bob's label, others keep their paired model. */
export function deviceModelLabel(device: { model: string; board: string | null }): string {
  return isBobDevice(device) ? BOB_MODEL_LABEL : device.model;
}

/** The wake word a device shows when it has none stored or reported. Display only: never pushed. */
export const DEFAULT_WAKE_WORD: WakeWord = 'bob';

export const ANNOUNCE_TITLE_MAX = 28;
export const ANNOUNCE_BODY_MAX = 200;
