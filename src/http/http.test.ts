import { describe, expect, it } from 'vitest';
import { parseHttpFile, requestAt } from './parse';
import { jsonAt, parseEnvironments, resolveVariables, type Scope } from './variables';
import { curlOf } from './client';

const FILE = `@host = http://localhost:8000
@api = {{host}}/api

### Log in
# @name login
POST {{api}}/login
Content-Type: application/json

{"email": "a@b.c", "password": "secret"}

> {% client.global.set("token", response.body.token); %}

### Orders
# @no-redirect
# @timeout 5
GET {{api}}/orders
    ?page=2
    &sort=date
Authorization: Bearer {{login.response.body.token}}

###
https://example.com/health
`;

describe('parseHttpFile', () => {
  const requests = parseHttpFile(FILE);

  it('finds each request with its title, line, method, url, headers and body', () => {
    expect(requests.map((r) => [r.title, r.line, r.method, r.url])).toEqual([
      ['Log in', 6, 'POST', '{{api}}/login'],
      ['Orders', 16, 'GET', '{{api}}/orders?page=2&sort=date'],
      ['GET https://example.com/health', 22, 'GET', 'https://example.com/health'],
    ]);
    expect(requests[0].headers).toEqual([['Content-Type', 'application/json']]);
    expect(requests[0].body).toBe('{"email": "a@b.c", "password": "secret"}');
    expect(requests[1].body).toBeNull();
  });

  it('reads the options and the file variables', () => {
    expect(requests[0].options).toEqual({ name: 'login' });
    expect(requests[1].options).toEqual({ noRedirect: true, timeoutMs: 5000 });
    expect(requests[0].variables).toEqual({ host: 'http://localhost:8000', api: '{{host}}/api' });
  });

  it('knows which request the caret is in', () => {
    expect(requestAt(requests, 4)?.title).toBe('Log in');
    expect(requestAt(requests, 9)?.title).toBe('Log in');
    expect(requestAt(requests, 13)?.title).toBe('Orders');
    expect(requestAt(requests, 23)?.method).toBe('GET');
    expect(requestAt(requests, 1)?.title).toBe('Log in');
  });

  it('ignores blocks without a request line', () => {
    expect(parseHttpFile('### Notes\n# just a comment\n')).toEqual([]);
  });
});

describe('resolveVariables', () => {
  const scope: Scope = {
    file: { api: '{{host}}/api' },
    env: { host: 'https://staging.example.com', id: '7' },
    responses: new Map([['login', { status: 200, headers: [['X-Token', 'abc']], body: '{"token":"t1","user":{"roles":["admin"]}}' }]]),
  };

  it('fills file, environment and response variables, nested ones too', () => {
    expect(resolveVariables('{{api}}/users/{{ id }}', scope)).toEqual({ text: 'https://staging.example.com/api/users/7', missing: [] });
    expect(resolveVariables('{{login.response.body.token}} {{login.response.body.$.user.roles[0]}} {{login.response.headers.x-token}} {{login.response.status}}', scope).text).toBe('t1 admin abc 200');
  });

  it('lists what has no value', () => {
    expect(resolveVariables('{{nope}} {{other.response.body.x}}', scope)).toEqual({ text: '{{nope}} {{other.response.body.x}}', missing: ['nope', 'other.response.body.x'] });
  });

  it('has built-in values', () => {
    expect(resolveVariables('{{$uuid}}', scope).text).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(resolveVariables('{{$timestamp}}', scope).text)).toBeGreaterThan(1_700_000_000);
  });
});

describe('jsonAt and parseEnvironments', () => {
  it('reads paths into JSON', () => {
    expect(jsonAt('{"a":{"b":[1,{"c":"x"}]}}', 'a.b[1].c')).toBe('x');
    expect(jsonAt('{"a":{"b":2}}', '$.a')).toBe('{"b":2}');
    expect(jsonAt('not json', 'a')).toBeUndefined();
  });

  it("lets the private file's values win", () => {
    const envs = parseEnvironments('{"dev":{"host":"http://localhost","port":8000,"nested":{"x":1}}}', '{"dev":{"token":"s3cret"},"prod":{"host":"https://x"}}');
    expect(envs).toEqual({ dev: { host: 'http://localhost', port: '8000', token: 's3cret' }, prod: { host: 'https://x' } });
  });
});

describe('curlOf', () => {
  it('quotes the URL, headers and body for a shell', () => {
    expect(curlOf({ method: 'POST', url: 'https://x.test/a?b=1', headers: [['Content-Type', 'application/json']], body: `{"n":"it's"}` })).toBe(
      String.raw`curl -X POST 'https://x.test/a?b=1' -H 'Content-Type: application/json' --data-raw '{"n":"it'\''s"}'`,
    );
    expect(curlOf({ method: 'GET', url: 'https://x.test', headers: [], body: null })).toBe(`curl 'https://x.test'`);
  });
});
