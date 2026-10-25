import { describe, expect, it } from 'vitest';
import { csvDelimiter, imageType, isCsv, isRasterImage, isSvg, parseCsv } from './fileKinds';
import { languageOf } from './php';

describe('file kinds', () => {
  it('tells images and tables apart', () => {
    expect(isRasterImage('/p/logo.PNG')).toBe(true);
    expect(isRasterImage('/p/icon.svg')).toBe(false);
    expect(isSvg('/p/icon.svg')).toBe(true);
    expect(isCsv('/p/data.tsv')).toBe(true);
    expect(isCsv('/p/data.json')).toBe(false);
    expect(imageType('a.jpg')).toBe('image/jpeg');
    expect(imageType('a.webp')).toBe('image/webp');
  });
});

describe('csv', () => {
  it('finds the delimiter in the first line', () => {
    expect(csvDelimiter('a.csv', 'a;b;c\n1,2;3;4')).toBe(';');
    expect(csvDelimiter('a.csv', 'a,b\n')).toBe(',');
    expect(csvDelimiter('a.csv', 'a\tb\tc')).toBe('\t');
    expect(csvDelimiter('a.tsv', 'a,b,c')).toBe('\t');
    expect(csvDelimiter('a.csv', 'single')).toBe(',');
  });

  it('parses quotes, escaped quotes and line breaks in fields', () => {
    expect(parseCsv('id,name\n1,"Smith, J"\n2,"say ""hi"""\n', ',')).toEqual([
      ['id', 'name'],
      ['1', 'Smith, J'],
      ['2', 'say "hi"'],
    ]);
    expect(parseCsv('a,b\r\n"x\ny",z', ',')).toEqual([
      ['a', 'b'],
      ['x\ny', 'z'],
    ]);
    expect(parseCsv('a,,c\n', ',')).toEqual([['a', '', 'c']]);
    expect(parseCsv('', ',')).toEqual([]);
  });
});

describe('languageOf', () => {
  it.each([
    ['/p/config/services.yaml', 'yaml'],
    ['/p/.github/workflows/ci.yml', 'yaml'],
    ['/p/config.neon', 'yaml'],
    ['/p/templates/base.html.twig', 'twig'],
    ['/p/view.phtml', 'php'],
    ['/p/phpunit.xml.dist', 'xml'],
    ['/p/.php-cs-fixer.dist.php', 'php'],
    ['/p/translations/messages.en.xlf', 'xml'],
    ['/p/composer.lock', 'json'],
    ['/p/.eslintrc', 'json'],
    ['/p/Dockerfile', 'dockerfile'],
    ['/p/docker/php.Dockerfile', 'dockerfile'],
    ['/p/bin/setup.bash', 'shell'],
    ['/p/run.ps1', 'powershell'],
    ['/p/build.cmd', 'bat'],
    ['/p/.editorconfig', 'ini'],
    ['/p/pyproject.toml', 'ini'],
    ['/p/schema.graphql', 'graphql'],
    ['/p/data.csv', 'csv'],
    ['/p/data.tsv', 'csv'],
    ['/p/icon.svg', 'xml'],
    ['/p/.env.local', 'dotenv'],
    ['/p/README', 'plaintext'],
  ])('%s is %s', (path, lang) => {
    expect(languageOf(path)).toBe(lang);
  });
});

describe('guessLanguage', () => {
  it.each([
    ['/p/symfony.lock', '{\n    "composer/pcre": {\n        "version": "1.0.1"\n    }\n}\n', 'json'],
    ['/p/data.lock', '[1, 2, 3]', 'json'],
    ['/p/bin/console', '#!/usr/bin/env php\n<?php\n', 'php'],
    ['/p/bin/deploy', '#!/bin/bash\nset -e\n', 'shell'],
    ['/p/tool', '#!/usr/bin/env python3\nprint(1)\n', 'python'],
    ['/p/view', '<?php echo 1;', 'php'],
    ['/p/feed', '<?xml version="1.0"?>\n<rss/>', 'xml'],
    ['/p/page', '<!DOCTYPE html>\n<html></html>', 'html'],
    ['/p/.php_cs', '<?php return [];', 'php'],
    ['/p/config', '# settings\nname: shop\nversion: 2\nservices:\n  - web\n', 'yaml'],
    ['/p/settings', '[core]\nbare = false\n', 'ini'],
    ['/p/notes', 'Remember to update the docs.\nAnd the tests.', 'plaintext'],
    ['/p/LICENSE', 'MIT License\n\nCopyright (c) 2026: someone', 'plaintext'],
  ])('%s is %s', (path, text, lang) => {
    expect(languageOf(path, text)).toBe(lang);
  });

  it('keeps the language the name gives', () => {
    expect(languageOf('/p/a.md', '{"looks": "like json"}')).toBe('markdown');
  });
});
