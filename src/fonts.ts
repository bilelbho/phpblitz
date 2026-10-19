// Monospaced fonts installed on this computer, for the font pickers in Settings. Browsers can't list
// system fonts without a permission prompt, so this checks well-known programming fonts: a font is
// installed when text in it measures differently from the fallback fonts alone.

const KNOWN = [
  'JetBrains Mono',
  'Cascadia Code',
  'Cascadia Mono',
  'Consolas',
  'Fira Code',
  'Fira Mono',
  'Source Code Pro',
  'Hack',
  'Menlo',
  'Monaco',
  'SF Mono',
  'Ubuntu Mono',
  'DejaVu Sans Mono',
  'Liberation Mono',
  'Noto Sans Mono',
  'Roboto Mono',
  'IBM Plex Mono',
  'Iosevka',
  'Victor Mono',
  'Inconsolata',
  'Courier New',
  'Lucida Console',
  'Space Mono',
  'Anonymous Pro',
  'Input Mono',
  'Monaspace Neon',
  'Monaspace Argon',
  'Monaspace Xenon',
  'Monaspace Radon',
  'Monaspace Krypton',
  'Geist Mono',
  'Comic Mono',
  'Operator Mono',
  'Dank Mono',
  'Berkeley Mono',
  'Intel One Mono',
  'Commit Mono',
  'Maple Mono',
  'Hasklig',
  'Fantasque Sans Mono',
  'Red Hat Mono',
  'Martian Mono',
  'Azeret Mono',
  'Sarasa Mono SC',
  'Office Code Pro',
];

/** Shipped with PHPBlitz: always available. */
const BUNDLED = ['JetBrains Mono'];

let cached: string[] | null = null;

export function installedMonoFonts(): string[] {
  if (cached) return cached;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return (cached = BUNDLED);
  const sample = 'mmmmmmmmmmlli10OQ@#';
  const width = (font: string) => {
    ctx.font = `32px ${font}`;
    return ctx.measureText(sample).width;
  };
  const fallbacks = ['monospace', 'serif', 'sans-serif'].map((f) => [f, width(f)] as const);
  const found = KNOWN.filter((name) => BUNDLED.includes(name) || fallbacks.some(([f, w]) => width(`'${name}', ${f}`) !== w));
  return (cached = found);
}
