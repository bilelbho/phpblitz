// File-type icons (Tabler, outline, stroke 1.25), tinted by type. PHP files show what they declare
// (class, interface, trait, enum) as a letter, from the symbol index.

import type { ComponentType } from 'react';
import {
  IconBrandDocker,
  IconBrandGit,
  IconBrandNpm,
  IconBrandVue,
  IconCertificate,
  IconDatabase,
  IconEyeOff,
  IconFile,
  IconFileCode,
  IconFileText,
  IconFileTypeCss,
  IconFileTypeHtml,
  IconFileTypeJs,
  IconFileTypePhp,
  IconFileTypeTs,
  IconFileTypeXml,
  IconFileZip,
  IconJson,
  IconLock,
  IconMarkdown,
  IconPhoto,
  IconSettings,
  IconTemplate,
  IconTerminal2,
  IconVariable,
  type IconProps,
} from '@tabler/icons-react';
import { symbols, useSymbols } from '../symbols';

/** Tabler's stroke for all of PHPBlitz's icons. */
export const STROKE = 1.25;

const BLUE = '#548af7';
const GREEN = '#5fb865';
const ORANGE = '#e3a869';
const PURPLE = '#a68cf0';
const YELLOW = '#e8c37e';
const RED = '#e06c75';
const GREY = '#a8adbd';
const DOCKER = '#3d9ae8';
const PHP = '#8c9ef5';

type Tabler = ComponentType<IconProps>;

/** A letter in a circle, drawn like Tabler's icons: PHP class (C), interface (I), trait (T), enum (E). */
function Declares({ letter, color, size }: { letter: string; color: string; size: number }) {
  return (
    <svg className="file-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill={color} fillOpacity="0.14" stroke={color} strokeWidth={STROKE} />
      <text x="12" y="16.2" textAnchor="middle" fontSize="11.5" fontWeight="600" fontFamily="Inter, sans-serif" fill={color}>
        {letter}
      </text>
    </svg>
  );
}

/** The icon and color for a file name. */
function iconFor(path: string): [Tabler, string] {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop()! : '';

  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile') || /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(name)) return [IconBrandDocker, DOCKER];
  if (name === '.gitignore' || name === '.gitattributes' || name === '.gitmodules') return [IconBrandGit, ORANGE];
  if (name.endsWith('ignore')) return [IconEyeOff, GREY];
  if (name.startsWith('.env')) return [IconVariable, YELLOW];
  if (name === 'composer.lock' || name === 'package-lock.json' || name === 'yarn.lock' || name === 'pnpm-lock.yaml') return [IconLock, GREY];
  if (name === 'package.json') return [IconBrandNpm, RED];
  if (name === 'license' || name.startsWith('license.') || name === 'notice') return [IconCertificate, GREY];
  if (name.endsWith('.blade.php')) return [IconTemplate, RED];

  switch (ext) {
    case 'php':
      return [IconFileTypePhp, PHP];
    case 'md':
    case 'markdown':
      return [IconMarkdown, BLUE];
    case 'json':
      return [IconJson, YELLOW];
    case 'lock':
      return [IconLock, GREY];
    case 'yml':
    case 'yaml':
    case 'conf':
    case 'ini':
    case 'cnf':
    case 'toml':
    case 'neon':
      return [IconSettings, ext === 'yml' || ext === 'yaml' ? RED : ORANGE];
    case 'twig':
      return [IconTemplate, GREEN];
    case 'html':
    case 'htm':
      return [IconFileTypeHtml, ORANGE];
    case 'xml':
    case 'xsd':
    case 'dist':
      return [IconFileTypeXml, ORANGE];
    case 'vue':
      return [IconBrandVue, GREEN];
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return [IconFileTypeJs, YELLOW];
    case 'ts':
    case 'tsx':
      return [IconFileTypeTs, BLUE];
    case 'css':
    case 'scss':
    case 'less':
      return [IconFileTypeCss, BLUE];
    case 'sh':
    case 'bash':
    case 'ps1':
    case 'bat':
    case 'cmd':
      return [IconTerminal2, GREY];
    case 'sql':
    case 'sqlite':
    case 'db':
      return [IconDatabase, PURPLE];
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
    case 'ico':
      return [IconPhoto, PURPLE];
    case 'zip':
    case 'gz':
    case 'tar':
    case 'phar':
      return [IconFileZip, GREY];
    case 'txt':
    case 'log':
    case 'csv':
      return [IconFileText, GREY];
    case 'py':
    case 'rb':
    case 'go':
    case 'rs':
    case 'java':
    case 'c':
    case 'cpp':
    case 'h':
      return [IconFileCode, GREY];
    default:
      return [IconFile, GREY];
  }
}

/** The icon for a file, 16 px by default. */
export function FileIcon({ path, size = 16 }: { path: string; size?: number }) {
  // Re-render when the index learns what the file declares (C / I / T / E).
  useSymbols();
  if (path.toLowerCase().endsWith('.php') && !path.toLowerCase().endsWith('.blade.php')) {
    const kind = symbols.kindOf(path);
    if (kind === 'class') return <Declares letter="C" color={BLUE} size={size} />;
    if (kind === 'interface') return <Declares letter="I" color={GREEN} size={size} />;
    if (kind === 'trait') return <Declares letter="T" color={ORANGE} size={size} />;
    if (kind === 'enum') return <Declares letter="E" color={PURPLE} size={size} />;
  }
  const [Glyph, color] = iconFor(path);
  return <Glyph className="file-icon" size={size} stroke={STROKE} color={color} aria-hidden="true" />;
}
