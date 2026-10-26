import { defineConfig } from 'vitepress';
import { blitzDark, blitzLight } from './blitz-shiki';

const repo = 'https://github.com/bilelbho/phpblitz';

// The documentation site: https://phpblitz.com/ (built by .github/workflows/docs.yml).
export default defineConfig({
  title: 'PHPBlitz',
  description: 'A fast, open source PHP IDE, built with Rust.',
  lang: 'en-US',
  base: '/',
  cleanUrls: true,
  lastUpdated: true,
  appearance: 'dark',
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/logo.png' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap' }],
    ['meta', { name: 'theme-color', content: '#1e1f22' }],
    ['meta', { property: 'og:title', content: 'PHPBlitz: a fast, open source PHP IDE' }],
    ['meta', { property: 'og:image', content: 'https://phpblitz.com/screenshots/editor.png' }],
  ],
  markdown: { theme: { light: blitzLight, dark: blitzDark } },
  themeConfig: {
    logo: '/logo.png',
    nav: [
      { text: 'Guide', link: '/guide/install', activeMatch: '/guide/' },
      { text: 'Shortcuts', link: '/reference/shortcuts' },
      { text: 'Reference', link: '/reference/project-files', activeMatch: '/reference/' },
      { text: 'Download', link: '/guide/install' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Getting started',
          items: [
            { text: 'Install', link: '/guide/install' },
            { text: 'Your first project', link: '/guide/first-project' },
          ],
        },
        {
          text: 'Working with code',
          items: [
            { text: 'Editor', link: '/guide/editor' },
            { text: 'Navigation and refactoring', link: '/guide/navigation' },
            { text: 'Errors and analysis', link: '/guide/analysis' },
            { text: 'JavaScript and TypeScript', link: '/guide/javascript' },
            { text: 'Layouts', link: '/guide/layouts' },
          ],
        },
        {
          text: 'Tools',
          items: [
            { text: 'Tests', link: '/guide/tests' },
            { text: 'Debugging', link: '/guide/debugging' },
            { text: 'Terminal', link: '/guide/terminal' },
            { text: 'Git', link: '/guide/git' },
            { text: 'Databases', link: '/guide/databases' },
            { text: 'Composer and npm', link: '/guide/composer' },
            { text: 'AI', link: '/guide/ai' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Keyboard shortcuts', link: '/reference/shortcuts' },
            { text: 'Project files (.blitz)', link: '/reference/project-files' },
            { text: 'Your code and privacy', link: '/reference/privacy' },
            { text: 'Troubleshooting', link: '/reference/troubleshooting' },
          ],
        },
        {
          text: 'Contributing',
          items: [{ text: 'Build from source', link: '/contributing/build' }],
        },
      ],
      '/contributing/': [
        {
          text: 'Contributing',
          items: [{ text: 'Build from source', link: '/contributing/build' }],
        },
      ],
    },
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
    footer: {
      message: 'Released under the Apache License 2.0. PHPBlitz is an independent project.',
      copyright: 'Copyright © 2026 The PHPBlitz Authors',
    },
  },
});
