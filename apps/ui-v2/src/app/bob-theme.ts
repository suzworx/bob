import { defineTheme, type DefinedTheme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral';

// Nunito for body and headings, DM Mono for code. A child theme's `typography` REPLACES its base's, so
// every theme that extends neutralTheme sets it itself. The fonts are loaded by main.tsx (self-hosted
// @fontsource); Astryx only names the families.
const bobTypography = {
  body: { family: 'Nunito', fallbacks: 'system-ui, sans-serif' },
  heading: { family: 'Nunito', fallbacks: 'system-ui, sans-serif' },
  code: { family: 'DM Mono', fallbacks: 'ui-monospace, monospace' },
};

// Hover and selected rings. Neutral's are blue in every theme, so each theme sets its own: hover is a
// quiet ink (light) or white (dark) wash, selected is the theme's accent.
// Every colour value in the app lives in this file. The pinned values below are measured (WCAG).
const ring = (color: string): string => `inset 0px 0px 0px 2px ${color}`;
const LIGHT_HOVER = ring('#1c292426');
const DARK_HOVER = ring('#ffffff29');

// The heybob palette: ink #173e57, paper #fffdf6, yellow #f0c75e, sky #bbddf0, coral #f07a6a.

// Bob's one theme (2026-10 redesign): neutral's own white and grey surfaces, with Bob's ink as the
// accent in light mode and sky-tinted paper in dark mode, so primary buttons and selection read as
// ink, not as a colour. Bob yellow is reserved for Bob himself (the mark, the device face) and is in
// no token here. Measured (WCAG): white on ink 11.6:1; ink on #e8f1f7 10.1:1; sky on neutral's dark
// surface above 10:1.
export const bobTheme = defineTheme({
  name: 'bob',
  extends: neutralTheme,
  typography: bobTypography,
  tokens: {
    '--color-accent': ['#173e57', '#e8f1f7'],
    '--color-on-accent': ['#ffffff', '#173e57'],
    '--color-accent-muted': ['#173e571f', '#e8f1f733'],
    '--color-text-accent': ['#173e57', '#bbddf0'],
    '--color-icon-accent': ['#173e57', '#bbddf0'],
    '--focus-outline-color': ['#173e57', '#bbddf0'],
    '--shadow-inset-hover': ring('light-dark(#173e5726, #ffffff29)'),
    '--shadow-inset-selected': ring('light-dark(#173e5766, #bbddf066)'),
  },
});

// Bob's earlier pair (cream paper and navy, yellow accent). Still registered, no longer the default.
// Measured (WCAG): ink on yellow 7.00, ink on paper 11.07, paper on ink 11.07, yellow on ink 7.00.
const bobPaperTheme = defineTheme({
  name: 'bob-paper',
  extends: neutralTheme,
  typography: bobTypography,
  tokens: {
    '--color-accent': '#f0c75e',
    '--color-on-accent': '#173e57',
    '--color-accent-muted': '#f0c75e40',
    '--color-text-accent': '#173e57',
    '--color-icon-accent': '#173e57',
    '--focus-outline-color': '#173e57',
    '--color-background-body': '#fffdf6',
    '--color-background-surface': '#fffdf6',
    '--color-background-card': '#ffffff',
    '--color-background-popover': '#ffffff',
    '--color-text-primary': '#173e57',
    '--color-icon-primary': '#173e57',
    '--color-text-secondary': '#3d5f77',
    '--color-icon-secondary': '#3d5f77',
    '--color-border': '#173e5733',
    '--color-background-muted': '#bbddf033',
    '--shadow-inset-hover': LIGHT_HOVER,
    '--shadow-inset-selected': ring('#f0c75ecc'),
  },
});

const bobNavyTheme = defineTheme({
  name: 'bob-navy',
  extends: neutralTheme,
  typography: bobTypography,
  tokens: {
    '--color-accent': '#f0c75e',
    '--color-on-accent': '#173e57',
    '--color-accent-muted': '#f0c75e33',
    '--color-text-accent': '#f0c75e',
    '--color-icon-accent': '#f0c75e',
    '--focus-outline-color': '#f0c75e',
    '--color-background-body': '#0f2a3c',
    '--color-background-surface': '#173e57',
    '--color-background-card': '#173e57',
    '--color-background-popover': '#173e57',
    '--color-text-primary': '#fffdf6',
    '--color-icon-primary': '#fffdf6',
    '--color-text-secondary': '#bbddf0',
    '--color-icon-secondary': '#bbddf0',
    '--color-border': '#bbddf033',
    '--color-background-muted': '#bbddf014',
    '--shadow-inset-hover': DARK_HOVER,
    '--shadow-inset-selected': ring('#f0c75ecc'),
  },
});

export type ThemeId = 'bob' | 'bob-dark' | 'bob-paper' | 'bob-navy';

// Every theme stays registered; the person chooses only the mode (System / Light / Dark), and each
// scheme renders its default (theme-choice.ts). 'bob' and 'bob-dark' are the same theme, the default
// of each scheme.
export const THEME_OPTIONS: ReadonlyArray<{
  id: ThemeId;
  label: string;
  scheme: 'light' | 'dark';
  theme: DefinedTheme;
}> = [
  { id: 'bob', label: 'Bob', scheme: 'light', theme: bobTheme },
  { id: 'bob-paper', label: 'Bob paper', scheme: 'light', theme: bobPaperTheme },
  { id: 'bob-dark', label: 'Bob', scheme: 'dark', theme: bobTheme },
  { id: 'bob-navy', label: 'Bob navy', scheme: 'dark', theme: bobNavyTheme },
];

export const DEFAULT_LIGHT_THEME: ThemeId = 'bob';
export const DEFAULT_DARK_THEME: ThemeId = 'bob-dark';
