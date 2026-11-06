import { describe, expect, it } from 'vitest';
import { checkState, checksSummary, stateLabel, type Check } from './github';

const run = (status: string, conclusion = ''): Check => ({ __typename: 'CheckRun', name: 'build', status, conclusion });

describe('checksSummary', () => {
  it('counts passed, failed and pending checks', () => {
    const checks = [run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'FAILURE'), run('IN_PROGRESS'), run('COMPLETED', 'SKIPPED'), { __typename: 'StatusContext', context: 'ci', state: 'PENDING' } as Check];
    expect(checksSummary(checks)).toEqual({ passed: 2, failed: 1, pending: 2, overall: 'failed' });
  });

  it('is pending while nothing failed, and none without checks', () => {
    expect(checksSummary([run('COMPLETED', 'SUCCESS'), run('QUEUED')]).overall).toBe('pending');
    expect(checksSummary([run('COMPLETED', 'SUCCESS')]).overall).toBe('passed');
    expect(checksSummary([]).overall).toBe('none');
  });
});

describe('checkState', () => {
  it('reads check runs and commit statuses', () => {
    expect(checkState(run('COMPLETED', 'CANCELLED'))).toBe('failed');
    expect(checkState(run('COMPLETED', 'NEUTRAL'))).toBe('skipped');
    expect(checkState({ __typename: 'StatusContext', state: 'SUCCESS' })).toBe('passed');
    expect(checkState({ __typename: 'StatusContext', state: 'ERROR' })).toBe('failed');
  });
});

describe('stateLabel', () => {
  it('shows drafts, merged and closed pull requests', () => {
    expect(stateLabel({ state: 'OPEN', isDraft: true })).toBe('Draft');
    expect(stateLabel({ state: 'OPEN', isDraft: false })).toBe('Open');
    expect(stateLabel({ state: 'MERGED', isDraft: false })).toBe('Merged');
    expect(stateLabel({ state: 'CLOSED', isDraft: false })).toBe('Closed');
  });
});
