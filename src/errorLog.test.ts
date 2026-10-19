import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => Promise.resolve('9.9.9') }));
vi.mock('./platform', () => ({ isTauri: false }));
vi.stubGlobal('navigator', { userAgent: 'Windows', hardwareConcurrency: 8 });

const { clearErrors, errorReport, logError } = await import('./errorLog');
const entries = () =>
  errorReport()
    .split('\n')
    .filter((l) => l.startsWith('['));

beforeEach(clearErrors);

describe('error log', () => {
  it('keeps one entry for a panel crash React also reports as unhandled', () => {
    const e = new Error('boom');
    logError('Unhandled error', e);
    logError('Panel: npm', e, 'at NpmPanel');
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatch(/Panel: npm: Error: boom$/);
    expect(errorReport()).toContain('Component stack:at NpmPanel');
  });

  it('drops browser noise and repeats, keeps different errors', () => {
    logError('Unhandled error', 'ResizeObserver loop completed with undelivered notifications.');
    logError('Background task', new TypeError('x is undefined'));
    logError('Background task', new TypeError('x is undefined'));
    logError('Background task', 'disk full');
    expect(entries().map((l) => l.replace(/^\[[^\]]+\] /, ''))).toEqual(['Background task: TypeError: x is undefined', 'Background task: disk full']);
  });

  it('starts the report with the app and system', () => {
    expect(errorReport().split('\n')[0]).toMatch(/^PHPBlitz .* · Windows · 8 cores$/);
  });
});
