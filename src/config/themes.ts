export interface Theme {
  id: string;
  name: string;
  description: string;
  colors: {
    primary: { from: string; to: string };
    secondary: { from: string; to: string };
    accent: { from: string; to: string };
    background: {
      base: string;
      gradient1: string;
      gradient2: string;
      gradient3: string;
    };
    text: {
      primary: string;
      secondary: string;
      tertiary: string;
    };
    card: {
      bg: string;
      border: string;
      hover: string;
    };
  };
}

export const themes: Record<string, Theme> = {
  lavender: {
    id: 'lavender',
    name: 'Lavender Dream',
    description: 'Soft purples and blues with cream accents',
    colors: {
      primary: { from: '#9d6bff', to: '#6d2de3' },
      secondary: { from: '#0ea5e9', to: '#0284c7' },
      accent: { from: '#eb6f4f', to: '#d94f2e' },
      background: {
        base: '#fef9f5',
        gradient1: 'rgba(186,148,255,0.12)',
        gradient2: 'rgba(235,111,79,0.08)',
        gradient3: 'rgba(14,165,233,0.06)',
      },
      text: {
        primary: '#252b28',
        secondary: '#556059',
        tertiary: '#8a9691',
      },
      card: {
        bg: 'rgba(255,255,255,0.8)',
        border: 'rgba(107,120,113,0.2)',
        hover: 'rgba(157,107,255,0.1)',
      },
    },
  },
  
  ocean: {
    id: 'ocean',
    name: 'Ocean Breeze',
    description: 'Cool blues and teals with sandy accents',
    colors: {
      primary: { from: '#0ea5e9', to: '#0369a1' },
      secondary: { from: '#14b8a6', to: '#0f766e' },
      accent: { from: '#f59e0b', to: '#d97706' },
      background: {
        base: '#f0f9ff',
        gradient1: 'rgba(14,165,233,0.15)',
        gradient2: 'rgba(20,184,166,0.1)',
        gradient3: 'rgba(245,158,11,0.05)',
      },
      text: {
        primary: '#0c4a6e',
        secondary: '#0e7490',
        tertiary: '#06b6d4',
      },
      card: {
        bg: 'rgba(255,255,255,0.9)',
        border: 'rgba(14,165,233,0.2)',
        hover: 'rgba(14,165,233,0.15)',
      },
    },
  },

  forest: {
    id: 'forest',
    name: 'Forest Sage',
    description: 'Earthy greens with warm brown tones',
    colors: {
      primary: { from: '#10b981', to: '#047857' },
      secondary: { from: '#84cc16', to: '#65a30d' },
      accent: { from: '#f97316', to: '#ea580c' },
      background: {
        base: '#f7fdf7',
        gradient1: 'rgba(16,185,129,0.12)',
        gradient2: 'rgba(132,204,22,0.08)',
        gradient3: 'rgba(249,115,22,0.06)',
      },
      text: {
        primary: '#14532d',
        secondary: '#166534',
        tertiary: '#16a34a',
      },
      card: {
        bg: 'rgba(255,255,255,0.85)',
        border: 'rgba(16,185,129,0.2)',
        hover: 'rgba(16,185,129,0.12)',
      },
    },
  },

  sunset: {
    id: 'sunset',
    name: 'Sunset Glow',
    description: 'Warm oranges and pinks with purple highlights',
    colors: {
      primary: { from: '#ec4899', to: '#be185d' },
      secondary: { from: '#f97316', to: '#c2410c' },
      accent: { from: '#8b5cf6', to: '#6d28d9' },
      background: {
        base: '#fff7ed',
        gradient1: 'rgba(236,72,153,0.12)',
        gradient2: 'rgba(249,115,22,0.1)',
        gradient3: 'rgba(139,92,246,0.08)',
      },
      text: {
        primary: '#831843',
        secondary: '#9f1239',
        tertiary: '#be123c',
      },
      card: {
        bg: 'rgba(255,255,255,0.85)',
        border: 'rgba(236,72,153,0.2)',
        hover: 'rgba(236,72,153,0.12)',
      },
    },
  },

  midnight: {
    id: 'midnight',
    name: 'Midnight Blue',
    description: 'Deep blues with silver and cyan accents',
    colors: {
      primary: { from: '#3b82f6', to: '#1e40af' },
      secondary: { from: '#06b6d4', to: '#0e7490' },
      accent: { from: '#a78bfa', to: '#7c3aed' },
      background: {
        base: '#f8fafc',
        gradient1: 'rgba(59,130,246,0.1)',
        gradient2: 'rgba(6,182,212,0.08)',
        gradient3: 'rgba(167,139,250,0.06)',
      },
      text: {
        primary: '#1e3a8a',
        secondary: '#1e40af',
        tertiary: '#3b82f6',
      },
      card: {
        bg: 'rgba(255,255,255,0.9)',
        border: 'rgba(59,130,246,0.2)',
        hover: 'rgba(59,130,246,0.12)',
      },
    },
  },
};

export const defaultTheme = 'lavender';

export function getTheme(themeId: string): Theme {
  return themes[themeId] || themes[defaultTheme];
}
