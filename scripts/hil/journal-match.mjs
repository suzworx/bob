/** Match top-level journal fields, independently of metadata and key order. */
export class JournalMatch {
  constructor(fields) {
    this.fields = Object.freeze({ ...fields });
    this.source = JSON.stringify(fields, (_key, value) => value instanceof RegExp ? String(value) : value);
  }

  test(line) {
    let record;
    try { record = JSON.parse(line); } catch { return false; }
    if (!record || Array.isArray(record) || typeof record !== 'object') return false;
    return Object.entries(this.fields).every(([key, expected]) => {
      if (!Object.hasOwn(record, key)) return false;
      if (!(expected instanceof RegExp)) return record[key] === expected;
      expected.lastIndex = 0;
      return expected.test(String(record[key]));
    });
  }

  toString() { return this.source; }
}

export function journalMatch(fields) { return new JournalMatch(fields); }
