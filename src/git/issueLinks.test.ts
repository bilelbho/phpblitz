import { describe, expect, it } from 'vitest';
import { linkify, remoteIssueLink } from './issueLinks';

describe('remoteIssueLink', () => {
  it('knows GitHub, GitLab and Bitbucket, over https and ssh', () => {
    expect(remoteIssueLink('https://github.com/acme/shop.git')?.url).toBe('https://github.com/acme/shop/issues/$1');
    expect(remoteIssueLink('git@github.com:acme/shop.git')?.url).toBe('https://github.com/acme/shop/issues/$1');
    expect(remoteIssueLink('ssh://git@gitlab.com/group/sub/app')?.url).toBe('https://gitlab.com/group/sub/app/-/issues/$1');
    expect(remoteIssueLink('https://user@bitbucket.org/team/repo/')?.url).toBe('https://bitbucket.org/team/repo/issues/$1');
  });

  it('returns null for other hosts', () => {
    expect(remoteIssueLink('https://git.example.com/acme/shop.git')).toBeNull();
    expect(remoteIssueLink('C:/repos/shop')).toBeNull();
  });
});

describe('linkify', () => {
  const gh = {
    pattern: '#(\\d+)',
    url: 'https://github.com/acme/shop/issues/$1',
  };
  const jira = {
    pattern: '[A-Z][A-Z0-9]+-\\d+',
    url: 'https://jira.example.com/browse/$0',
  };

  it('links issue numbers and keys', () => {
    expect(linkify('Fix #12 (SHOP-7)', [gh, jira])).toEqual([
      'Fix ',
      { text: '#12', url: 'https://github.com/acme/shop/issues/12' },
      ' (',
      { text: 'SHOP-7', url: 'https://jira.example.com/browse/SHOP-7' },
      ')',
    ]);
  });

  it('links web addresses without trailing punctuation', () => {
    expect(linkify('See https://example.com/a?b=1.', [])).toEqual(['See ', { text: 'https://example.com/a?b=1', url: 'https://example.com/a?b=1' }, '.']);
  });

  it('leaves matches inside words, overlaps and bad patterns alone', () => {
    expect(linkify('fooSHOP-7', [jira])).toEqual(['fooSHOP-7']);
    expect(linkify('https://example.com/#12', [gh])).toEqual([{ text: 'https://example.com/#12', url: 'https://example.com/#12' }]);
    expect(linkify('Fix #1', [{ pattern: '(', url: 'https://x/$1' }])).toEqual(['Fix #1']);
  });

  it('only makes http(s) links', () => {
    expect(linkify('#3', [{ pattern: '#(\\d+)', url: 'javascript:alert($1)' }])).toEqual(['#3']);
  });
});
