// A conservative clear-silence guard, not a speech detector. Keep anything with
// at least 30 ms of AC signal above 4 PCM16 LSB RMS (about -78 dBFS). Remove DC
// per 10 ms frame so a stuck microphone offset does not count as audio. A lone
// click can affect at most two frames and does not justify a hands-free turn.
export function hasPcmSignal(pcm: Buffer): boolean {
  const samplesPerFrame = 160;
  let activeFrames = 0;
  for (let offset = 0; offset + samplesPerFrame * 2 <= pcm.length; offset += samplesPerFrame * 2) {
    let sum = 0;
    let squares = 0;
    for (let i = 0; i < samplesPerFrame; i++) {
      const sample = pcm.readInt16LE(offset + i * 2);
      sum += sample;
      squares += sample * sample;
    }
    const mean = sum / samplesPerFrame;
    const variance = squares / samplesPerFrame - mean * mean;
    if (variance > 16) activeFrames += 1;
    if (activeFrames >= 3) return true;
  }
  return false;
}
