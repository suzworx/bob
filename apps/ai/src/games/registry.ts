/**
 * Games registry: the GameDefinition of every playable
 * game, by GameId. Each launch game is a built-in with a title and a
 * one-line pitch for list_games. Built-ins register on the registry's first
 * use, not at import, because a game module imports engine-tools, which
 * imports this file: registering at import would read a game before its
 * module finished evaluating.
 *
 * Parental settings (safety.md S4) decide which registered games an account
 * may see; allowedGames() is the one filter both list_games and start_game use.
 */
import type { Band, GameDefinition, GameId } from './engine.ts';
import { ANIMAL_RIDDLES_META, animalRiddles } from './animal-riddles.ts';
import { SIMON_SAYS_META, simonSays } from './simon-says.ts';

export interface RegisteredGame {
  definition: GameDefinition<unknown>;
  /** Up to 20 chars, the device title. */
  title: string;
  /** One spoken line for list_games. */
  pitch: string;
  /**
   * The game's fixed prompt frames (Simon's "Simon says"). In an active game a
   * reply carrying one more often than the turn's tool outputs did is off
   * script (S1): the model composed game content, and the server replaces it.
   */
  cues: readonly string[];
  /** The tool that gives the next prompt; the server runs it when an off-script reply had no tool behind it. */
  advance?: string;
}

/** Fixed copy a game registers with; never generated. */
export interface GameMeta {
  title: string;
  pitch: string;
  cues?: readonly string[];
  advance?: string;
}

const BAND_ORDER: readonly Band[] = ['little', 'kid', 'grown'];

const games = new Map<GameId, RegisteredGame>();
let builtinsLoaded = false;

/** Registers the built-in games once, before any read or write. */
function registry(): Map<GameId, RegisteredGame> {
  if (!builtinsLoaded) {
    builtinsLoaded = true;
    add(animalRiddles, ANIMAL_RIDDLES_META);
    add(simonSays, SIMON_SAYS_META);
  }
  return games;
}

function add<S>(definition: GameDefinition<S>, meta: GameMeta): void {
  if (meta.title.length === 0 || meta.title.length > 20) throw new Error('game title must be 1..20 chars');
  if (meta.pitch.length === 0 || meta.pitch.length > 120) throw new Error('game pitch must be 1..120 chars');
  const cues = (meta.cues ?? []).filter((cue) => cue.trim() !== '');
  games.set(definition.id, {
    definition: definition as GameDefinition<unknown>, title: meta.title, pitch: meta.pitch, cues,
    ...(meta.advance === undefined ? {} : { advance: meta.advance }),
  });
}

/** Adds (or replaces) a game. The title, pitch and cues are fixed copy, never generated. */
export function registerGame<S>(definition: GameDefinition<S>, meta: GameMeta): void {
  registry();
  add(definition, meta);
}

/** Removes a game; tests use it to reset the registry. */
export function unregisterGame(id: GameId): void {
  registry().delete(id);
}

export function getGame(id: GameId): RegisteredGame | undefined {
  return registry().get(id);
}

/** Every registered game, in registration order. */
export function registeredGames(): RegisteredGame[] {
  return [...registry().values()];
}

/** True when `band` is at or below `max` (little < kid < grown). */
function bandWithin(band: Band, max: Band): boolean {
  return BAND_ORDER.indexOf(band) <= BAND_ORDER.indexOf(max);
}

export function lowerBand(a: Band, b: Band): Band {
  return bandWithin(a, b) ? a : b;
}

/**
 * The registered games an account may play: listed in its allowed games, and
 * offering at least one band at or below its max band (and equal to `band`
 * when one is asked for).
 */
export function allowedGames(settings: { allowedGames: readonly GameId[]; maxBand: Band }, band?: Band): RegisteredGame[] {
  return registeredGames().filter(({ definition }) => {
    if (!settings.allowedGames.includes(definition.id)) return false;
    if (band !== undefined) return bandWithin(band, settings.maxBand) && definition.bands.includes(band);
    return definition.bands.some((offered) => bandWithin(offered, settings.maxBand));
  });
}
