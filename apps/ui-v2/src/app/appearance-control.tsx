import type { ReactElement } from 'react';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { isThemeChoice, setThemeChoice, THEME_CHOICES, useThemeChoice } from './theme-choice';

/**
 * System / Light / Dark: a SegmentedControl, which always has exactly one
 * choice. The choice lives in the shared theme store, so the Astryx Theme in
 * app.tsx follows it; the theme itself is the brand's own. Saved per device.
 */
export function AppearanceControl(): ReactElement {
  const choice = useThemeChoice();
  return (
    <SegmentedControl
      label="Appearance"
      size="sm"
      value={choice}
      onChange={(next) => {
        if (isThemeChoice(next)) {
          setThemeChoice(next);
        }
      }}
    >
      {THEME_CHOICES.map((option) => (
        <SegmentedControlItem key={option.value} value={option.value} label={option.label} />
      ))}
    </SegmentedControl>
  );
}
