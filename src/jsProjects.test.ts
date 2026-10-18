import { describe, expect, it } from 'vitest';
import { findJsProjects, parseJsonc, resolvePath, viteAliases } from './jsProjects';

describe('findJsProjects', () => {
  it('finds folders with a manifest or a tsconfig, outermost first', () => {
    const files = [
      '/app/resources/js/tsconfig.json',
      '/app/package.json',
      '/app/node_modules/vue/package.json',
      '/app/vendor/x/package.json',
      '/app/tools/tsconfig.app.json',
      '/app/web/jsconfig.json',
      '/app/web/tsconfig.node.json',
    ];
    expect(findJsProjects(files)).toEqual([
      { root: '/app', manifest: '/app/package.json', configs: [] },
      { root: '/app/web', manifest: null, configs: ['/app/web/jsconfig.json', '/app/web/tsconfig.node.json'] },
      { root: '/app/resources/js', manifest: null, configs: ['/app/resources/js/tsconfig.json'] },
    ]);
  });
});

describe('configuration', () => {
  it('parses JSON with comments and trailing commas', () => {
    const text = `{
      // a comment
      "compilerOptions": { "paths": { "@/*": ["./src/*"], }, /* block */ "url": "http://x//y" },
    }`;
    expect(parseJsonc(text)).toEqual({ compilerOptions: { paths: { '@/*': ['./src/*'] }, url: 'http://x//y' } });
  });

  it('resolves relative and absolute paths', () => {
    expect(resolvePath('/app/web', '../shared/./types')).toBe('/app/shared/types');
    expect(resolvePath('/app', 'C:/other')).toBe('C:/other');
    expect(resolvePath('/app', '/root')).toBe('/root');
  });

  it('reads Vite aliases', () => {
    const text = `export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './resources/js'),
      '~': '/src/',
      '#utils': fileURLToPath(new URL('./utils', import.meta.url)),
      'vue': 'vue/dist/vue.esm-bundler.js',
    },
  },
});`;
    expect(viteAliases(text)).toEqual({ '@': 'resources/js', '~': 'src', '#utils': 'utils' });
  });
});
