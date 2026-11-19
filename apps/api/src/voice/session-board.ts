/** The board a device session reported in its hello (bounded by OtaBoardSchema),
 *  kept beside the session so the turn code can label journal events and
 *  metadata. Firmware whose hello carries none reads as "cardputer". */
const boards = new WeakMap<object, string>();

export function recordBoard(session: object, board: string | undefined): string {
  if (board !== undefined) boards.set(session, board);
  return sessionBoard(session);
}

export function sessionBoard(session: object): string {
  return boards.get(session) ?? 'cardputer';
}
