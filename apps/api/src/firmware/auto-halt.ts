export interface HaltInput {
  attempts: number;
  rollbacks: number;
  fleetSize: number;
}

const MIN_ATTEMPTS = 10;
const MAX_ROLLBACK_RATE = 0.05;
const SMALL_FLEET = 20;
const SMALL_FLEET_ROLLBACKS = 2;

/** True when the window of outcomes says the channel's version should stop being offered. */
export function shouldHalt({ attempts, rollbacks, fleetSize }: HaltInput): boolean {
  if (attempts >= MIN_ATTEMPTS && rollbacks / attempts > MAX_ROLLBACK_RATE) return true;
  return fleetSize < SMALL_FLEET && rollbacks >= SMALL_FLEET_ROLLBACKS;
}
