const PATHS = {
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
  commit: 'M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM3 12h5.5M15.5 12H21',
  structure: 'M3 3h7v5H3zM14 10h7v5h-7zM14 17h7v4h-7zM6.5 8v4.5H14M6.5 12.5V19H14',
  database: 'M4.5 5.5c0-1.4 3.4-2.5 7.5-2.5s7.5 1.1 7.5 2.5S16.1 8 12 8 4.5 6.9 4.5 5.5zM4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4',
  sparkle: 'M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8zM18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  route: 'M7 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM21 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM7 6h7a3.5 3.5 0 0 1 0 7h-4a3.5 3.5 0 0 0 0 7h7',
  box: 'M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  shelve: 'M12 3v10M8 9.5l4 4 4-4M4 14v5.5h16V14',
  search: 'M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0zM20 20l-3.5-3.5',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  close: 'M6 6l12 12M18 6 6 18',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  branch: 'M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM20 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM6 7v10M18 10c0 4-6 3-11.5 7',
  bug: 'M7 12a5 5 0 0 1 10 0v3a5 5 0 0 1-10 0zM9 7a3 3 0 0 1 6 0M3 13h4M17 13h4M4 7l3 2M20 7l-3 2M4 20l3-2M20 20l-3-2',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  check: 'M5 12l5 5 9-10',
  terminal: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  folderOpen: 'M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h7.5A1.5 1.5 0 0 1 20 9.5V11M3 7.5V18l2.6-6.2A1.5 1.5 0 0 1 7 11h14l-3 7.1a1.5 1.5 0 0 1-1.4.9H3',
  menu: 'M4 7h16M4 12h16M4 17h16',
  more: 'M12 5.5v.01M12 12v.01M12 18.5v.01',
  chevronUp: 'M6 15l6-6 6 6',
  winMin: 'M5 12h14',
  winMax: 'M6 6h12v12H6z',
  winClose: 'M6 6l12 12M18 6 6 18',
  warning: 'M12 4 2.5 20h19zM12 10v4.5M12 17.2v.01',
  error: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM9 9l6 6M15 9l-6 6',
  expandAll: 'M7 9l5-5 5 5M7 15l5 5 5-5',
  collapseAll: 'M7 4l5 5 5-5M7 20l5-5 5 5',
  rollback: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  git: 'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 3v12M18 9a9 9 0 0 1-9 9',
  run: 'M7 4.5v15l12-7.5z',
  lockOpen: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 5.8-1',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  cut: 'M9 7a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM9 17a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM8.5 8.5 20 18M8.5 15.5 20 6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  paste: 'M9 4h6v3H9zM8 5.5H5V21h14V5.5h-3',
  columns: 'M4 4h6v16H4zM14 4h6v16h-6z',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  goTo: 'M5 12h13M13 6l6 6-6 6',
  target: 'M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0zM12 2v4M12 18v4M2 12h4M18 12h4M13.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
  newFile: 'M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9zM13 3v6h6M12 12v6M9 15h6',
  explorer: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5zM12 11v5M9.5 13.5h5',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, strokeWidth = 2, className }: { name: IconName; size?: number; strokeWidth?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Play({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 4.5v15l12-7.5z" fill="currentColor" />
    </svg>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="#2b2d30" />
      <path d="M13.5 3.5 6.5 13.5h5l-1 7 7-10h-5z" fill="#f2a93b" />
    </svg>
  );
}

/** JetBrains-style symbol icon (class, method, field…): a tinted circle with a colored letter. */
export function Sym({ letter, color }: { letter: string; color: string }) {
  return (
    <span className="sym" style={{ color, background: `${color}26` }} aria-hidden="true">
      {letter}
    </span>
  );
}

/** Visibility marker shown next to Structure items: open lock = public, closed = private. */
export function Visibility({ value }: { value: 'public' | 'protected' | 'private' }) {
  const color = value === 'public' ? '#5fb865' : value === 'protected' ? '#e5a33d' : '#e06c75';
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round" aria-label={value} role="img">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      {value === 'public' ? <path d="M8 11V8a4 4 0 0 1 7.5-2" /> : value === 'protected' ? <path d="M8 11V8a4 4 0 0 1 8 0" strokeDasharray="3 2" /> : <path d="M8 11V8a4 4 0 0 1 8 0v3" />}
    </svg>
  );
}

/** Small colored square with a letter, used for file types, symbol kinds and tables. */
export function Badge({ text, color, round }: { text: string; color: string; round?: boolean }) {
  return (
    <span className={'badge' + (round ? ' badge-round' : '')} style={{ background: color }} aria-hidden="true">
      {text}
    </span>
  );
}

export function fileBadge(path: string): { text: string; color: string } {
  const name = path.split('/').pop() ?? '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (name.endsWith('.blade.php')) return { text: 'B', color: '#E87C7C' };
  switch (ext) {
    case 'php':
      return { text: 'P', color: '#9D8CF5' };
    case 'json':
      return { text: '{}', color: '#E8C37E' };
    case 'js':
    case 'mjs':
    case 'ts':
      return { text: 'JS', color: '#E8C37E' };
    case 'css':
    case 'scss':
      return { text: '#', color: '#72B7F2' };
    case 'md':
      return { text: 'M', color: '#A9B0BC' };
    case 'xml':
    case 'html':
      return { text: '<>', color: '#E3A869' };
    case 'yml':
    case 'yaml':
      return { text: 'Y', color: '#E87C7C' };
    default:
      return { text: name.startsWith('.env') ? 'E' : '·', color: '#7F8798' };
  }
}
