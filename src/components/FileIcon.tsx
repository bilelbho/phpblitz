// File-type icons in the style of JetBrains' new UI: PHP files show what they declare (class,
// interface, trait, enum), other files their type (Markdown, Docker, JSON, YAML, Twig, .env…).

import type { ReactNode } from 'react';
import { symbols, useSymbols } from '../symbols';

const BLUE = '#548af7';
const GREEN = '#5fb865';
const ORANGE = '#e3a869';
const PURPLE = '#a68cf0';
const YELLOW = '#e8c37e';
const RED = '#e06c75';
const GREY = '#a8adbd';
const DOCKER = '#3d9ae8';

/** A letter in a circle: PHP class (C), interface (I), trait (T), enum (E). */
function Circled({ letter, color }: { letter: string; color: string }) {
  return (
    <>
      <circle cx="8" cy="8" r="6.2" fill={color} fillOpacity="0.16" stroke={color} strokeWidth="1.3" />
      <text x="8" y="11" textAnchor="middle" fontSize="8.6" fontWeight="700" fontFamily="Inter, sans-serif" fill={color}>
        {letter}
      </text>
    </>
  );
}

function Label({ text, color, size = 7, italic }: { text: string; color: string; size?: number; italic?: boolean }) {
  return (
    <text x="8" y="10.8" textAnchor="middle" fontSize={size} fontWeight="700" fontStyle={italic ? 'italic' : undefined} fontFamily="Inter, sans-serif" fill={color}>
      {text}
    </text>
  );
}

const sheet = (color: string) => <path d="M4 1.8h5.3L12.5 5v9.2H4z M9.2 1.8V5h3.3" fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />;

function glyph(path: string): ReactNode {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop()! : '';

  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile') || /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(name)) {
    // The Docker whale: containers on its back.
    return (
      <g fill={DOCKER}>
        <path d="M1.5 8.6h11.6c.5-1 1.4-1.4 2.2-1.2-.2.9-.8 1.5-1.6 1.6-1 3-3.6 4.6-7 4.6-2.8 0-4.6-1.6-5.2-5z" />
        <rect x="3" y="6.1" width="2" height="1.8" rx=".3" />
        <rect x="5.4" y="6.1" width="2" height="1.8" rx=".3" />
        <rect x="7.8" y="6.1" width="2" height="1.8" rx=".3" />
        <rect x="5.4" y="3.8" width="2" height="1.8" rx=".3" />
      </g>
    );
  }
  if (name === '.gitignore' || name === '.dockerignore' || name.endsWith('ignore')) {
    return (
      <g fill="none" stroke={GREY} strokeWidth="1.3">
        <circle cx="8" cy="8" r="5.6" />
        <path d="M4 12 12 4" />
      </g>
    );
  }
  if (name.startsWith('.env')) {
    return <path d="M3 4.5h10M3 8h10M3 11.5h6.5" stroke={GREY} strokeWidth="1.4" strokeLinecap="round" />;
  }
  if (name.endsWith('.blade.php')) return <Label text="B" color={RED} size={9} />;

  switch (ext) {
    case 'php': {
      const kind = symbols.kindOf(path);
      if (kind === 'class') return <Circled letter="C" color={BLUE} />;
      if (kind === 'interface') return <Circled letter="I" color={GREEN} />;
      if (kind === 'trait') return <Circled letter="T" color={ORANGE} />;
      if (kind === 'enum') return <Circled letter="E" color={PURPLE} />;
      return <Label text="php" color="#8c9ef5" size={6.6} italic />;
    }
    case 'md':
    case 'markdown':
      return <Label text="M↓" color={BLUE} size={7.4} />;
    case 'json':
    case 'lock':
      return <Label text="{ }" color={ext === 'lock' ? GREY : YELLOW} size={8} />;
    case 'yml':
    case 'yaml':
      return (
        <>
          {sheet(RED)}
          <path d="M6.2 8.2 7.6 10l1.6-2.2M7.6 10v2" stroke={RED} strokeWidth="1" fill="none" strokeLinecap="round" />
        </>
      );
    case 'twig':
      // A sprig.
      return <path d="M8.5 14C8 10 9 6 12.5 2.5 13 7 11.5 10.5 8.5 14zM8 14c-.3-2.6-1.8-4.5-4.6-5.6.2 2.8 1.8 4.7 4.6 5.6z" fill="#7cb342" />;
    case 'conf':
    case 'ini':
    case 'cnf':
    case 'toml':
    case 'neon':
      return (
        <g fill="none" stroke={ORANGE} strokeWidth="1.3">
          <circle cx="8" cy="8" r="2.4" />
          <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6 5 5M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" strokeLinecap="round" />
        </g>
      );
    case 'html':
    case 'htm':
    case 'xml':
    case 'vue':
      return <Label text="<>" color={ext === 'vue' ? GREEN : ORANGE} size={8} />;
    case 'js':
    case 'mjs':
    case 'cjs':
      return <Label text="JS" color={YELLOW} size={7} />;
    case 'ts':
    case 'tsx':
      return <Label text="TS" color={BLUE} size={7} />;
    case 'css':
    case 'scss':
    case 'less':
      return <Label text="#" color={BLUE} size={9.5} />;
    case 'sh':
    case 'bash':
    case 'ps1':
    case 'bat':
    case 'cmd':
      return (
        <>
          <rect x="1.8" y="3" width="12.4" height="10" rx="1.6" fill="none" stroke={GREY} strokeWidth="1.2" />
          <path d="M4.5 6.2 6.6 8l-2.1 1.8M7.8 10.2h3" stroke={GREY} strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </>
      );
    case 'sql':
      return (
        <g fill="none" stroke={PURPLE} strokeWidth="1.2">
          <ellipse cx="8" cy="4" rx="4.8" ry="1.9" />
          <path d="M3.2 4v8c0 1 2.1 1.9 4.8 1.9s4.8-.9 4.8-1.9V4M3.2 8c0 1 2.1 1.9 4.8 1.9s4.8-.9 4.8-1.9" />
        </g>
      );
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
    case 'ico':
      return (
        <>
          <rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke={PURPLE} strokeWidth="1.2" />
          <path d="M3.5 11.5 6.5 8l2 2.2 1.5-1.4 2.5 2.7" stroke={PURPLE} strokeWidth="1.1" fill="none" strokeLinejoin="round" />
        </>
      );
    case 'txt':
    case 'log':
      return (
        <>
          {sheet(GREY)}
          <path d="M6 8h4.5M6 10.5h4.5" stroke={GREY} strokeWidth="1" />
        </>
      );
    default:
      return sheet(GREY);
  }
}

/** The icon for a file, 16 px. */
export function FileIcon({ path, size = 16 }: { path: string; size?: number }) {
  // Re-render when the index learns what the file declares (C / I / T / E).
  useSymbols();
  return (
    <svg className="file-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {glyph(path)}
    </svg>
  );
}
