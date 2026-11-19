import { describe, expect, it } from 'vitest';
import { compare, countViolations } from './check-ios-design.mjs';

describe('countViolations', () => {
  it('counts each way a screen goes around the design system', () => {
    const swift = `
      Text("a").font(.caption)
      Text("b").font(.system(size: 12))
      Text("c").foregroundStyle(.secondary)
      Color(red: 1, green: 0, blue: 0)
      RoundedRectangle(cornerRadius: 14)
      view.shadow(radius: 2)
      view.sensoryFeedback(.success, trigger: x)
      withAnimation(.easeOut(duration: 0.2)) {}
    `;
    expect(countViolations(swift)).toEqual({
      'raw-font': 2,
      'system-grey': 1,
      'raw-color': 1,
      'literal-radius': 1,
      shadow: 1,
      'raw-haptic': 1,
      'raw-animation': 1,
    });
  });

  it('accepts design system tokens and ignores comments', () => {
    const swift = `
      // .font(.caption) in a comment
      Text("a").font(BobFont.secondary).foregroundStyle(BobColor.muted)
      RoundedRectangle(cornerRadius: BobLayout.controlRadius)
      view.bobFeedback(.success, trigger: x).bobAnimation(value: y)
    `;
    expect(countViolations(swift)).toEqual({});
  });
});

describe('compare', () => {
  it('fails a rise and a new file, and reports a fall', () => {
    const baseline = { 'A.swift': { 'raw-font': 3 }, 'B.swift': { shadow: 1 } };
    const current = { 'A.swift': { 'raw-font': 4 }, 'C.swift': { 'raw-color': 1 } };
    const { rises, falls } = compare(current, baseline);
    expect(rises).toEqual(['A.swift: raw-font 3 -> 4', 'C.swift: raw-color 0 -> 1']);
    expect(falls).toEqual(['B.swift: shadow 1 -> 0']);
  });

  it('passes when nothing changed', () => {
    const same = { 'A.swift': { 'raw-font': 2 } };
    expect(compare(same, same)).toEqual({ rises: [], falls: [] });
  });
});
