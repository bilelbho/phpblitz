import { describe, expect, it } from 'vitest';
import { parseHttpFile } from './parse';
import { appendRequest, boundaryOf, draftOf, duplicateRequest, filePathFrom, formBody, formOf, linesOf, multipartBody, multipartOf, queryOf, removeRequest, setHeader, withQuery, writeRequest, type LineEdit } from './edit';
import { curlOf, multipartBytes } from './client';

const FILE = `@host = http://localhost:8000

### Log in
# @name login
# Signs in the demo user.
POST {{host}}/login
Content-Type: application/json
# X-Debug: 1

{"email": "a@b.c"}

> {% client.global.set("token", response.body.token); %}

### Orders
GET {{host}}/orders?page=2&sort=date
Authorization: Bearer {{login.response.body.token}}
`;

const apply = (text: string, e: LineEdit) => {
  const lines = linesOf(text);
  return [...lines.slice(0, e.startLine - 1), ...(e.text === '' ? [] : linesOf(e.text)), ...lines.slice(e.endLine)].join('\n');
};

describe('request form', () => {
  const lines = linesOf(FILE);
  const [login, orders] = parseHttpFile(FILE);

  it('reads a request into fields, turned-off headers included', () => {
    const d = draftOf(lines, login);
    expect(d).toMatchObject({ title: 'Log in', method: 'POST', url: '{{host}}/login', body: '{"email": "a@b.c"}', options: { name: 'login' } });
    expect(d.headers).toEqual([
      { name: 'Content-Type', value: 'application/json', enabled: true },
      { name: 'X-Debug', value: '1', enabled: false },
    ]);
  });

  it('writes the same text back when nothing changed', () => {
    expect(apply(FILE, writeRequest(lines, login, draftOf(lines, login)))).toBe(FILE);
    expect(apply(FILE, writeRequest(lines, orders, draftOf(lines, orders)))).toBe(FILE);
  });

  it('writes a change, keeping comments, variables and the response handler', () => {
    const d = draftOf(lines, login);
    const text = apply(FILE, writeRequest(lines, login, { ...setHeader(d, 'Accept', '*/*'), method: 'PUT', options: { ...d.options, noRedirect: true } }));
    expect(text).toContain('### Log in\n# @name login\n# Signs in the demo user.\n# @no-redirect\nPUT {{host}}/login\nContent-Type');
    expect(text).toContain('Accept: */*\n\n{"email": "a@b.c"}\n\n> {% client');
    const again = parseHttpFile(text)[0];
    expect(again.headers).toContainEqual(['Accept', '*/*']);
    expect(again.options).toMatchObject({ name: 'login', noRedirect: true });
    // No body: the blank line goes too.
    const none = apply(FILE, writeRequest(lines, orders, { ...draftOf(lines, orders), body: null }));
    expect(none).toBe(FILE);
  });

  it('adds, copies and removes requests', () => {
    const added = appendRequest(lines);
    const text = apply(FILE, added.edit);
    expect(linesOf(text)[added.line - 1]).toBe('### New Request');
    expect(parseHttpFile(text)).toHaveLength(3);
    const copied = apply(FILE, duplicateRequest(lines, login));
    const rs = parseHttpFile(copied);
    expect(rs.map((r) => r.title)).toEqual(['Log in', 'Log in (copy)', 'Orders']);
    expect(rs[1].options.name).toBeUndefined();
    const removed = apply(FILE, removeRequest(lines, parseHttpFile(FILE), login));
    expect(parseHttpFile(removed).map((r) => r.title)).toEqual(['Orders']);
    // The file's first request: its variables stay.
    const plain = '@host = x\nGET {{host}}/a\n\n### B\nGET {{host}}/b\n';
    const first = parseHttpFile(plain)[0];
    expect(apply(plain, removeRequest(linesOf(plain), parseHttpFile(plain), first))).toBe('@host = x\n\n### B\nGET {{host}}/b\n');
  });

  it('edits the query and form bodies as rows', () => {
    expect(queryOf('{{host}}/orders?page=2&sort')).toEqual([
      { name: 'page', value: '2', enabled: true },
      { name: 'sort', value: '', enabled: true },
    ]);
    expect(withQuery('{{host}}/orders?page=2', [{ name: 'page', value: '3', enabled: true }, { name: 'q', value: '{{term}}', enabled: true }])).toBe('{{host}}/orders?page=3&q={{term}}');
    expect(withQuery('{{host}}/orders?page=2', [])).toBe('{{host}}/orders');
    expect(formOf('a=1&\nb=two')).toEqual([
      { name: 'a', value: '1', enabled: true },
      { name: 'b', value: 'two', enabled: true },
    ]);
    expect(formBody(formOf('a=1&b=2'))).toBe('a=1&b=2');
  });

  it('edits multipart forms with files', () => {
    const rows = [
      { name: 'title', value: 'Holiday', enabled: true },
      { name: 'photo', value: './img/beach.png', enabled: true, file: true },
      { name: 'empty', value: '', enabled: true, file: true },
    ];
    const body = multipartBody(rows, 'boundary');
    expect(body).toBe(
      [
        '--boundary',
        'Content-Disposition: form-data; name="title"',
        '',
        'Holiday',
        '--boundary',
        'Content-Disposition: form-data; name="photo"; filename="beach.png"',
        'Content-Type: image/png',
        '',
        '< ./img/beach.png',
        '--boundary',
        'Content-Disposition: form-data; name="empty"; filename=""',
        'Content-Type: application/octet-stream',
        '',
        '< ',
        '--boundary--',
      ].join('\n'),
    );
    expect(multipartOf(body, 'boundary')).toEqual(rows);
    expect(boundaryOf('multipart/form-data; boundary="abc"')).toBe('abc');
    expect(filePathFrom('C:/p/api/test.http', 'C:\\p\\api\\files\\a.pdf')).toBe('./files/a.pdf');
    expect(filePathFrom('C:/p/api/test.http', 'D:\\x.pdf')).toBe('D:/x.pdf');
  });

  it('sends multipart files as their bytes', async () => {
    const backend = { readBinary: async (p: string) => (p === 'C:/p/img/a.bin' ? new Uint8Array([0, 255, 13]).buffer : Promise.reject(new Error(p))) } as never;
    const body = '--b\nContent-Disposition: form-data; name="t"\n\n{{v}}\n--b\nContent-Disposition: form-data; name="f"; filename="a.bin"\n\n< ./img/a.bin\n--b--';
    const { base64, shown } = await multipartBytes(backend, 'C:/p', body, (s) => s.replace('{{v}}', 'x'));
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const expected = '--b\r\nContent-Disposition: form-data; name="t"\r\n\r\nx\r\n--b\r\nContent-Disposition: form-data; name="f"; filename="a.bin"\r\n\r\n\u0000\u00ff\r\r\n--b--\r\n';
    expect([...bytes]).toEqual([...expected].map((c) => c.charCodeAt(0)));
    expect(shown).toContain('< ./img/a.bin');
    expect(curlOf({ method: 'POST', url: 'http://h/u', headers: [['Content-Type', 'multipart/form-data; boundary=b']], body: shown })).toBe("curl -X POST 'http://h/u' -F 't=x' -F 'f=@./img/a.bin'");
  });
});
