// File ▸ New Project's project types: an empty PHP project, Composer packages and
// frameworks (Laravel, Symfony, Drupal), and JavaScript projects made by their official generators
// (Vite, Vue, Next.js, Angular…). Each type lists its options and turns them into steps: files to
// write, or command lines run in the new project's parent folder or in the project itself.
// Pure data, so the commands can be tested without running them.

export type Tool = 'composer' | 'node';

export type Option =
  | { kind: 'select'; id: string; label: string; choices: { value: string; label: string }[]; default: string }
  | { kind: 'segmented'; id: string; label: string; choices: { value: string; label: string }[]; default: string }
  | { kind: 'text'; id: string; label: string; placeholder?: string; default: string; pattern?: RegExp; required?: boolean; help?: string }
  | { kind: 'check'; id: string; label: string; default: boolean; help?: string; section?: string; columns?: boolean };

export type Values = Record<string, string | boolean>;

export type Step =
  | { kind: 'run'; title: string; where: 'parent' | 'project'; line: string }
  | { kind: 'files'; title: string; files: Record<string, string> };

export interface Generator {
  id: string;
  label: string;
  /** IconName from Icon.tsx. */
  icon: string;
  /** Brand color for the icon. */
  color?: string;
  group: '' | 'PHP specific' | 'Web';
  tool?: Tool;
  /** What the project's folder name may be (it goes into package names and command lines). */
  name?: { pattern: RegExp; hint: string };
  options: Option[];
  disabled?: (values: Values) => Record<string, boolean>;
  steps: (name: string, values: Values) => Step[];
}

/** Command-line-safe folder names: the name is passed to the generator unquoted. */
const SAFE = { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, hint: 'Use letters, digits, ".", "-" and "_" (no spaces).' };
const NPM = { pattern: /^[a-z0-9][a-z0-9._-]*$/, hint: 'npm package names use lowercase letters, digits, ".", "-" and "_".' };

const git: Option = { kind: 'check', id: 'git', label: 'Create Git repository', default: true };
const gitStep = (v: Values): Step[] => (v.git ? [{ kind: 'run', title: 'Creating the Git repository', where: 'project', line: 'git init' }] : []);
const npmInstall = (label = 'Install dependencies (npm install)'): Option => ({ kind: 'check', id: 'install', label, default: true });
const installStep = (v: Values): Step[] => (v.install ? [{ kind: 'run', title: 'Installing dependencies', where: 'project', line: 'npm install' }] : []);
const npx = (pkg: string, args: string) => `npx --yes ${pkg} ${args}`.trim();
const composerCreate = (pkg: string, name: string, version = '') => `composer create-project ${pkg} ${name}${version ? ` "${version}"` : ''} --no-progress --no-interaction`;

/** Laravel's optional packages: [composer package, label, help, dev dependency]. */
export const LARAVEL_PACKAGES: { id: string; pkg: string; label: string; help: string; dev?: boolean; section: string }[] = [
  { id: 'boost', pkg: 'laravel/boost', label: 'Laravel Boost (AI)', help: 'Context and tools for AI coding assistants', dev: true, section: 'Laravel packages' },
  { id: 'filament', pkg: 'filament/filament', label: 'Filament', help: 'Admin panels and forms', section: 'Laravel packages' },
  { id: 'sail', pkg: 'laravel/sail', label: 'Laravel Sail', help: 'Docker development environment', dev: true, section: 'Laravel packages' },
  { id: 'fortify', pkg: 'laravel/fortify', label: 'Laravel Fortify', help: 'Authentication back end', section: 'Laravel packages' },
  { id: 'folio', pkg: 'laravel/folio', label: 'Laravel Folio', help: 'Page-based routing', section: 'Laravel packages' },
  { id: 'horizon', pkg: 'laravel/horizon', label: 'Laravel Horizon', help: 'Redis queue dashboard', section: 'Laravel packages' },
  { id: 'sanctum', pkg: 'laravel/sanctum', label: 'Laravel Sanctum', help: 'API tokens and SPA authentication', section: 'Laravel packages' },
  { id: 'passport', pkg: 'laravel/passport', label: 'Laravel Passport (OAuth2)', help: 'OAuth2 server', section: 'Laravel packages' },
  { id: 'prompts', pkg: 'laravel/prompts', label: 'Laravel Prompts', help: 'Forms for command-line apps', section: 'Laravel packages' },
  { id: 'scout', pkg: 'laravel/scout', label: 'Laravel Scout', help: 'Full-text search for models', section: 'Laravel packages' },
  { id: 'socialite', pkg: 'laravel/socialite', label: 'Laravel Socialite', help: 'Sign in with GitHub, Google…', section: 'Laravel packages' },
  { id: 'telescope', pkg: 'laravel/telescope', label: 'Laravel Telescope', help: 'Debug assistant', section: 'Laravel packages' },
  { id: 'permission', pkg: 'spatie/laravel-permission', label: 'Spatie permission', help: 'Roles and permissions', section: 'Spatie packages' },
  { id: 'medialibrary', pkg: 'spatie/laravel-medialibrary', label: 'Spatie media library', help: 'Files attached to models', section: 'Spatie packages' },
  { id: 'querybuilder', pkg: 'spatie/laravel-query-builder', label: 'Spatie query builder', help: 'Filtering and sorting from the query string', section: 'Spatie packages' },
  { id: 'backup', pkg: 'spatie/laravel-backup', label: 'Spatie backup', help: 'Backups of files and databases', section: 'Spatie packages' },
];

export const GENERATORS: Generator[] = [
  {
    id: 'php',
    label: 'PHP Empty Project',
    icon: 'php',
    group: '',
    options: [{ kind: 'check', id: 'composer', label: 'Create composer.json (PSR-4 autoload from src/)', default: true }, git],
    steps: (name, v) => {
      const pkg = name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
      const files: Record<string, string> = {};
      if (v.composer) {
        files['composer.json'] = JSON.stringify({ name: `app/${pkg}`, type: 'project', require: { php: '>=8.2' }, autoload: { 'psr-4': { 'App\\': 'src/' } } }, null, 4) + '\n';
        files['src/.gitkeep'] = '';
      }
      return [{ kind: 'files', title: 'Creating the project', files }, ...gitStep(v)];
    },
  },
  {
    id: 'composer',
    label: 'Composer Package Project',
    icon: 'box',
    color: '#c8915f',
    group: 'PHP specific',
    tool: 'composer',
    name: SAFE,
    options: [
      { kind: 'text', id: 'package', label: 'Package', placeholder: 'vendor/package', default: '', pattern: /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/, required: true, help: 'From packagist.org, e.g. laravel/laravel or slim/slim-skeleton' },
      { kind: 'text', id: 'version', label: 'Version to install', placeholder: 'latest stable', default: '', pattern: /^[\w.*^~<>=|@ ,-]*$/ },
      git,
    ],
    steps: (name, v) => [{ kind: 'run', title: `Installing ${v.package}`, where: 'parent', line: composerCreate(String(v.package), name, String(v.version).trim()) }, ...gitStep(v)],
  },
  {
    id: 'laravel',
    label: 'Laravel',
    icon: 'laravel',
    color: '#f05340',
    group: 'PHP specific',
    tool: 'composer',
    name: SAFE,
    options: [
      git,
      {
        kind: 'select',
        id: 'kit',
        label: 'Starter Kit',
        default: 'laravel/laravel',
        choices: [
          { value: 'laravel/laravel', label: 'Base Laravel' },
          { value: 'laravel/react-starter-kit', label: 'React (Inertia, TypeScript, Tailwind)' },
          { value: 'laravel/vue-starter-kit', label: 'Vue (Inertia, TypeScript, Tailwind)' },
          { value: 'laravel/livewire-starter-kit', label: 'Livewire (Flux UI, Tailwind)' },
        ],
      },
      ...LARAVEL_PACKAGES.map((p): Option => ({ kind: 'check', id: p.id, label: p.label, help: `${p.help} (${p.pkg})`, default: false, section: p.section, columns: true })),
      { kind: 'check', id: 'pest', label: 'Pest', help: 'Pest instead of PHPUnit, with its Laravel plugin', default: false, section: 'Testing', columns: true },
      { kind: 'check', id: 'install', label: 'Install and build the front end (npm install, npm run build)', default: true, section: 'Front end' },
    ],
    steps: (name, v) => {
      const steps: Step[] = [{ kind: 'run', title: 'Creating the Laravel project', where: 'parent', line: composerCreate(String(v.kit), name) }];
      const chosen = LARAVEL_PACKAGES.filter((p) => v[p.id]);
      const prod = chosen.filter((p) => !p.dev).map((p) => p.pkg);
      const dev = chosen.filter((p) => p.dev).map((p) => p.pkg);
      if (prod.length) steps.push({ kind: 'run', title: 'Adding packages', where: 'project', line: `composer require ${prod.join(' ')} --no-progress --no-interaction` });
      if (dev.length) steps.push({ kind: 'run', title: 'Adding development packages', where: 'project', line: `composer require --dev ${dev.join(' ')} --no-progress --no-interaction` });
      if (v.pest) {
        steps.push(
          { kind: 'run', title: 'Replacing PHPUnit with Pest', where: 'project', line: 'composer remove --dev phpunit/phpunit --no-progress --no-interaction' },
          { kind: 'run', title: 'Adding Pest', where: 'project', line: 'composer require --dev pestphp/pest pestphp/pest-plugin-laravel --with-all-dependencies --no-progress --no-interaction' },
          { kind: 'run', title: 'Setting up Pest', where: 'project', line: 'php vendor/bin/pest --init' },
        );
      }
      if (v.install) steps.push({ kind: 'run', title: 'Installing the front end', where: 'project', line: 'npm install' }, { kind: 'run', title: 'Building the front end', where: 'project', line: 'npm run build' });
      return [...steps, ...gitStep(v)];
    },
  },
  {
    id: 'symfony',
    label: 'Symfony',
    icon: 'symfony',
    group: 'PHP specific',
    tool: 'composer',
    name: SAFE,
    options: [
      {
        kind: 'segmented',
        id: 'type',
        label: 'Project Type',
        default: 'web',
        choices: [
          { value: 'web', label: 'Web' },
          { value: 'console', label: 'Console' },
          { value: 'demo', label: 'Demo' },
        ],
      },
      {
        kind: 'select',
        id: 'version',
        label: 'Version',
        default: '',
        choices: [
          { value: '', label: 'latest' },
          { value: '7.4.*', label: '7.4 (LTS)' },
          { value: '6.4.*', label: '6.4 (LTS)' },
        ],
      },
      git,
    ],
    disabled: (v) => ({ version: v.type === 'demo' }),
    steps: (name, v) => {
      if (v.type === 'demo') return [{ kind: 'run', title: 'Creating the Symfony Demo application', where: 'parent', line: composerCreate('symfony/symfony-demo', name) }, ...gitStep(v)];
      const steps: Step[] = [{ kind: 'run', title: 'Creating the Symfony project', where: 'parent', line: composerCreate('symfony/skeleton', name, String(v.version)) }];
      if (v.type === 'web') steps.push({ kind: 'run', title: 'Adding the web application packages', where: 'project', line: 'composer require webapp --no-progress --no-interaction' });
      return [...steps, ...gitStep(v)];
    },
  },
  {
    id: 'drupal',
    label: 'Drupal',
    icon: 'drupal',
    color: '#2a9fd6',
    group: 'PHP specific',
    tool: 'composer',
    name: SAFE,
    options: [git],
    steps: (name, v) => [{ kind: 'run', title: 'Creating the Drupal project', where: 'parent', line: composerCreate('drupal/recommended-project', name) }, ...gitStep(v)],
  },
  {
    id: 'angular',
    label: 'Angular CLI',
    icon: 'angular',
    color: '#e23237',
    group: 'Web',
    tool: 'node',
    name: { pattern: /^[a-zA-Z][a-zA-Z0-9-]*$/, hint: 'Angular project names start with a letter and use letters, digits and "-".' },
    options: [
      {
        kind: 'select',
        id: 'style',
        label: 'Stylesheets',
        default: 'css',
        choices: ['css', 'scss', 'sass', 'less'].map((s) => ({ value: s, label: s.toUpperCase() })),
      },
      { kind: 'check', id: 'ssr', label: 'Server-side rendering (SSR)', default: false },
      git,
    ],
    steps: (name, v) => [
      { kind: 'run', title: 'Creating the Angular project', where: 'parent', line: npx('@angular/cli@latest', `new ${name} --defaults --skip-git --style=${v.style} ${v.ssr ? '--ssr' : '--ssr=false'}`) },
      ...gitStep(v),
    ],
  },
  {
    id: 'bootstrap',
    label: 'Bootstrap',
    icon: 'bootstrap',
    color: '#7952b3',
    group: 'Web',
    options: [git],
    steps: (name, v) => [{ kind: 'files', title: 'Creating the page', files: { 'index.html': bootstrapPage(name) } }, ...gitStep(v)],
  },
  {
    id: 'express',
    label: 'Express',
    icon: 'express',
    group: 'Web',
    tool: 'node',
    name: NPM,
    options: [
      {
        kind: 'select',
        id: 'view',
        label: 'Template engine',
        default: 'none',
        choices: [
          { value: 'none', label: 'None (API or static files)' },
          { value: 'ejs', label: 'EJS' },
          { value: 'pug', label: 'Pug' },
          { value: 'hbs', label: 'Handlebars' },
        ],
      },
      npmInstall(),
      git,
    ],
    steps: (name, v) => [
      { kind: 'run', title: 'Creating the Express application', where: 'parent', line: npx('express-generator@latest', `${name} ${v.view === 'none' ? '--no-view' : `--view=${v.view}`} --git`) },
      ...installStep(v),
      ...gitStep(v),
    ],
  },
  {
    id: 'next',
    label: 'Next.js',
    icon: 'nextjs',
    group: 'Web',
    tool: 'node',
    name: NPM,
    options: [
      { kind: 'check', id: 'ts', label: 'TypeScript', default: true },
      { kind: 'check', id: 'tailwind', label: 'Tailwind CSS', default: true },
      { kind: 'check', id: 'app', label: 'App Router', default: true },
      { kind: 'check', id: 'src', label: 'Code in a src/ folder', default: false },
    ],
    steps: (name, v) => [
      {
        kind: 'run',
        title: 'Creating the Next.js application',
        where: 'parent',
        line: npx('create-next-app@latest', `${name} ${v.ts ? '--ts' : '--js'} ${v.tailwind ? '--tailwind' : '--no-tailwind'} ${v.app ? '--app' : '--no-app'} ${v.src ? '--src-dir' : '--no-src-dir'} --import-alias "@/*" --use-npm --yes`),
      },
    ],
  },
  {
    id: 'node',
    label: 'Node.js',
    icon: 'nodejs',
    color: '#5fa04e',
    group: 'Web',
    name: NPM,
    options: [git],
    steps: (name, v) => [
      {
        kind: 'files',
        title: 'Creating the project',
        files: {
          'package.json': JSON.stringify({ name, version: '1.0.0', private: true, type: 'module', main: 'index.js', scripts: { start: 'node index.js' } }, null, 2) + '\n',
          'index.js': "console.log('Hello from Node.js');\n",
          '.gitignore': 'node_modules/\n',
        },
      },
      ...gitStep(v),
    ],
  },
  {
    id: 'nuxt',
    label: 'Nuxt',
    icon: 'nuxt',
    color: '#00dc82',
    group: 'Web',
    tool: 'node',
    name: NPM,
    options: [npmInstall(), git],
    steps: (name, v) => [
      // Installing is a step of its own, so a failed install still leaves an openable project.
      { kind: 'run', title: 'Creating the Nuxt application', where: 'parent', line: npx('nuxi@latest', `init ${name} --template minimal --packageManager npm --gitInit=false --no-install --force`) },
      ...installStep(v),
      ...gitStep(v),
    ],
  },
  {
    id: 'react',
    label: 'React',
    icon: 'react',
    color: '#61dafb',
    group: 'Web',
    tool: 'node',
    name: NPM,
    options: [
      {
        kind: 'select',
        id: 'template',
        label: 'Variant',
        default: 'react-ts',
        choices: [
          { value: 'react-ts', label: 'TypeScript' },
          { value: 'react-swc-ts', label: 'TypeScript + SWC' },
          { value: 'react', label: 'JavaScript' },
          { value: 'react-swc', label: 'JavaScript + SWC' },
        ],
      },
      npmInstall(),
      git,
    ],
    steps: (name, v) => viteSteps(name, String(v.template), v),
  },
  {
    id: 'vite',
    label: 'Vite',
    icon: 'vite',
    color: '#9d6cff',
    group: 'Web',
    tool: 'node',
    name: NPM,
    options: [
      {
        kind: 'select',
        id: 'template',
        label: 'Template',
        default: 'vanilla-ts',
        choices: [
          ['vanilla-ts', 'Vanilla TypeScript'],
          ['vanilla', 'Vanilla JavaScript'],
          ['vue-ts', 'Vue + TypeScript'],
          ['react-ts', 'React + TypeScript'],
          ['preact-ts', 'Preact + TypeScript'],
          ['lit-ts', 'Lit + TypeScript'],
          ['svelte-ts', 'Svelte + TypeScript'],
          ['solid-ts', 'Solid + TypeScript'],
          ['qwik-ts', 'Qwik + TypeScript'],
        ].map(([value, label]) => ({ value, label })),
      },
      npmInstall(),
      git,
    ],
    steps: (name, v) => viteSteps(name, String(v.template), v),
  },
  {
    id: 'vue',
    label: 'Vue.js',
    icon: 'vue',
    color: '#41b883',
    group: 'Web',
    tool: 'node',
    name: NPM,
    options: [
      { kind: 'check', id: 'ts', label: 'TypeScript', default: true },
      { kind: 'check', id: 'router', label: 'Vue Router', default: true },
      { kind: 'check', id: 'pinia', label: 'Pinia (state management)', default: false },
      { kind: 'check', id: 'vitest', label: 'Vitest (unit tests)', default: false },
      { kind: 'check', id: 'eslint', label: 'ESLint', default: true },
      npmInstall(),
      git,
    ],
    steps: (name, v) => {
      const flags = (['ts', 'router', 'pinia', 'vitest', 'eslint'] as const).filter((f) => v[f]).map((f) => `--${f}`);
      return [
        { kind: 'run', title: 'Creating the Vue application', where: 'parent', line: npx('create-vue@latest', `${name} ${flags.length ? flags.join(' ') : '--default'}`) },
        ...installStep(v),
        ...gitStep(v),
      ];
    },
  },
];

function viteSteps(name: string, template: string, v: Values): Step[] {
  return [{ kind: 'run', title: 'Creating the Vite project', where: 'parent', line: npx('create-vite@latest', `${name} --template ${template} --no-interactive`) }, ...installStep(v), ...gitStep(v)];
}

function bootstrapPage(name: string): string {
  const title = name.replace(/[<&>"]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body>
  <main class="container py-5">
    <h1>${title}</h1>
    <p class="lead">Built with Bootstrap.</p>
  </main>
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>
`;
}

export function defaultValues(g: Generator): Values {
  return Object.fromEntries(g.options.map((o) => [o.id, o.default]));
}

/** What's wrong with the options, or '' when the project can be created. */
export function validate(g: Generator, name: string, values: Values): string {
  if (!name) return 'Choose a location for the project.';
  if (!/^[^\\/:*?"<>|]+$/.test(name)) return 'The folder name can\'t contain \\ / : * ? " < > |';
  if (g.name && !g.name.pattern.test(name)) return `Project folder "${name}": ${g.name.hint}`;
  for (const o of g.options) {
    if (o.kind !== 'text') continue;
    const value = String(values[o.id] ?? '').trim();
    if (o.required && !value) return `${o.label} is required.`;
    if (value && o.pattern && !o.pattern.test(value)) return `${o.label}: "${value}" isn't valid.`;
  }
  return '';
}
