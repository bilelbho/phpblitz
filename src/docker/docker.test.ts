import { describe, expect, it } from 'vitest';
import { composeProjectName, composeServices, dockerError, jsonLines, parseLabels, toContainer, toImage } from './docker';

const PS = [
  '{"Command":"\\"docker-php-entrypoint php-fpm\\"","CreatedAt":"2026-11-06 10:00:00 +0100 CET","ID":"3f2a9c8e1b7d0011223344","Image":"php:8.3-fpm","Labels":"com.docker.compose.project=acme-shop,com.docker.compose.service=app,com.docker.compose.project.working_dir=C:\\\\demo\\\\acme-shop,x=a=b","Names":"acme-shop-app-1","Ports":"9000/tcp","State":"running","Status":"Up 2 hours"}',
  'WARNING: something',
  '{"ID":"aa11bb22cc33","Image":"redis:7","Labels":"","Names":"cache","Ports":"","State":"exited","Status":"Exited (0) 3 minutes ago"}',
].join('\n');

describe('docker output', () => {
  it('reads containers from JSON lines', () => {
    const cs = jsonLines(PS).map(toContainer);
    expect(cs).toHaveLength(2);
    expect(cs[0]).toMatchObject({ id: '3f2a9c8e1b7d', name: 'acme-shop-app-1', image: 'php:8.3-fpm', state: 'running', status: 'Up 2 hours' });
    expect(cs[0].labels['com.docker.compose.service']).toBe('app');
    expect(cs[0].labels.x).toBe('a=b');
    expect(jsonLines('[{"Name":"a"},{"Name":"b"}]')).toHaveLength(2);
    expect(parseLabels({ a: '1' })).toEqual({ a: '1' });
    expect(toImage({ ID: 'sha256:0123456789abcdef', Repository: 'php', Tag: '8.3-fpm', Size: '500MB', CreatedSince: '2 weeks ago' })).toMatchObject({ id: '0123456789ab', repository: 'php' });
  });

  it('matches compose services to this project’s containers', () => {
    const cs = jsonLines(PS).map(toContainer);
    const services = composeServices(['app', 'db', 'redis'], cs, 'C:/demo/acme-shop');
    expect(services.map((s) => [s.name, s.container?.name ?? null])).toEqual([
      ['app', 'acme-shop-app-1'],
      ['db', null],
      ['redis', null],
    ]);
    expect(composeServices(['app'], cs, 'C:/other')[0].container).toBeNull();
    expect(composeProjectName('C:/demo/Acme Shop.v2')).toBe('acmeshopv2');
  });

  it('says why Docker didn’t answer', () => {
    expect(dockerError({ code: 1, stdout: '', stderr: 'failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct' })).toMatch(/isn’t running/);
    expect(dockerError(new Error('Could not start docker: program not found'))).toMatch(/isn’t installed/);
    expect(dockerError({ code: 1, stdout: '', stderr: 'Error: No such container: x' })).toBe('Error: No such container: x');
  });
});
