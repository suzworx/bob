/**
 * One jsonb parameter cast (#898 escaped defect 15): `$N::jsonb` alone makes
 * postgres.js JSON-encode an already-serialized string a second time under
 * `prepare: true`, storing a jsonb STRING scalar instead of an object; binding
 * the value as text and casting keeps it an object.
 */
export function jsonbParam(placeholder: string): string {
  return `${placeholder}::text::jsonb`;
}
