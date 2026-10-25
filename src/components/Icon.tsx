// PHPBlitz's interface icons: Tabler Icons (MIT), outline, stroke 1.25.

import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArchive,
  IconArrowBackUp,
  IconArrowBarToDown,
  IconArrowBarUp,
  IconArrowForwardUp,
  IconArrowUpRight,
  IconBell,
  IconBookmark,
  IconBrandGit,
  IconBrandNpm,
  IconBrandPhp,
  IconBrandLaravel,
  IconBrandSymfony,
  IconBrandDrupal,
  IconBrandAngular,
  IconBrandBootstrap,
  IconServer2,
  IconBrandNextjs,
  IconBrandNodejs,
  IconBrandNuxt,
  IconBrandReact,
  IconBrandVite,
  IconBrandVue,
  IconBug,
  IconBulb,
  IconCalculator,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconChevronsDown,
  IconChevronsUp,
  IconCircleOff,
  IconClipboard,
  IconCode,
  IconColumns,
  IconCopy,
  IconCut,
  IconDatabase,
  IconDotsVertical,
  IconExternalLink,
  IconEye,
  IconFilePlus,
  IconFocus2,
  IconFolder,
  IconFolderOpen,
  IconGitBranch,
  IconGitCommit,
  IconHistory,
  IconKey,
  IconKeyboard,
  IconListCheck,
  IconListNumbers,
  IconListTree,
  IconInfoCircle,
  IconCircleCheck,
  IconTextSpellcheck,
  IconLock,
  IconLockOpen,
  IconMathFunction,
  IconMenu2,
  IconMinus,
  IconNumbers,
  IconPackage,
  IconPencil,
  IconBroadcast,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlayerTrackNext,
  IconPlugConnectedX,
  IconPlus,
  IconRefresh,
  IconRoute,
  IconSchema,
  IconSearch,
  IconServer,
  IconSettings,
  IconSparkles,
  IconSquare,
  IconTable,
  IconTableShortcut,
  IconTerminal2,
  IconUser,
  IconX,
  type IconProps,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconLayoutSidebar,
  IconLayoutSidebarRight,
} from '@tabler/icons-react';
import type { ComponentType } from 'react';
import { STROKE } from './FileIcon';
import appIcon from '../../app-icon.svg';

/** Our names for the icons, so the rest of the app doesn't depend on Tabler's. */
const ICONS = {
  // Database tool window.
  dbTable: IconTable,
  dbView: IconTableShortcut,
  dbColumn: IconColumns,
  dbKey: IconKey,
  dbIndex: IconListNumbers,
  dbSequence: IconNumbers,
  dbRoutine: IconMathFunction,
  dbRole: IconUser,
  dbSchema: IconSchema,
  dbServer: IconServer,
  dbConsole: IconTerminal2,
  disconnect: IconPlugConnectedX,
  // Debugger.
  resume: IconPlayerPlay,
  stopSquare: IconPlayerStop,
  pause: IconPlayerPause,
  stepOver: IconArrowForwardUp,
  stepInto: IconArrowBarToDown,
  stepOut: IconArrowBarUp,
  runToCursor: IconPlayerTrackNext,
  evaluate: IconCalculator,
  mute: IconCircleOff,
  listen: IconBroadcast,
  // Tool windows and the main toolbar.
  folder: IconFolder,
  folderOpen: IconFolderOpen,
  commit: IconGitCommit,
  structure: IconListTree,
  database: IconDatabase,
  bell: IconBell,
  sparkle: IconSparkles,
  route: IconRoute,
  box: IconPackage,
  terminal: IconTerminal2,
  bug: IconBug,
  run: IconPlayerPlay,
  git: IconBrandGit,
  npm: IconBrandNpm,
  php: IconBrandPhp,
  laravel: IconBrandLaravel,
  symfony: IconBrandSymfony,
  drupal: IconBrandDrupal,
  angular: IconBrandAngular,
  bootstrap: IconBrandBootstrap,
  express: IconServer2,
  nextjs: IconBrandNextjs,
  nodejs: IconBrandNodejs,
  nuxt: IconBrandNuxt,
  react: IconBrandReact,
  vite: IconBrandVite,
  vue: IconBrandVue,
  branch: IconGitBranch,
  todo: IconListCheck,
  gear: IconSettings,
  menu: IconMenu2,
  more: IconDotsVertical,
  // Actions.
  eye: IconEye,
  shelve: IconArchive,
  search: IconSearch,
  close: IconX,
  bookmark: IconBookmark,
  minus: IconMinus,
  plus: IconPlus,
  refresh: IconRefresh,
  check: IconCheck,
  expandAll: IconChevronsDown,
  collapseAll: IconChevronsUp,
  rollback: IconArrowBackUp,
  history: IconHistory,
  info: IconInfoCircle,
  keyboard: IconKeyboard,
  circleCheck: IconCircleCheck,
  spell: IconTextSpellcheck,
  lock: IconLock,
  lockOpen: IconLockOpen,
  bulb: IconBulb,
  cut: IconCut,
  copy: IconCopy,
  paste: IconClipboard,
  columns: IconColumns,
  code: IconCode,
  pencil: IconPencil,
  goTo: IconArrowUpRight,
  target: IconFocus2,
  newFile: IconFilePlus,
  explorer: IconExternalLink,
  // Chevrons, window buttons and status.
  chevronRight: IconChevronRight,
  chevronDown: IconChevronDown,
  chevronUp: IconChevronUp,
  winMin: IconMinus,
  winMax: IconSquare,
  sidebar: IconLayoutSidebar,
  panels: IconLayoutSidebarRight,
  maximize: IconArrowsMaximize,
  restore: IconArrowsMinimize,
  winClose: IconX,
  warning: IconAlertTriangle,
  error: IconAlertCircle,
} satisfies Record<string, ComponentType<IconProps>>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  const Glyph = ICONS[name];
  return <Glyph className={className} size={size} stroke={STROKE} aria-hidden="true" />;
}

export function Play({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 4.5v15l12-7.5z" fill="currentColor" />
    </svg>
  );
}

/** The PHPBlitz logo: app-icon.svg, the same artwork as the app icons (src-tauri/icons). */
export function Logo({ size = 22 }: { size?: number }) {
  return <img src={appIcon} width={size} height={size} alt="" aria-hidden="true" draggable={false} style={{ display: 'block' }} />;
}

/** Symbol icon (class, method, field…): a tinted circle with a colored letter. */
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
