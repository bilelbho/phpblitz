import { describe, expect, it } from 'vitest';
import { structureFromIndex } from './symbols';

describe('structureFromIndex', () => {
  it('lists classes, members, trait imports and functions in file order', () => {
    const text = ['<?php', 'class User extends Model', '{', '    use HasFactory, Notifiable;', '    const ROLE = 1;', '    public function name(): string {}', '}', 'function helper($a) {}'].join('\n');
    const rows = structureFromIndex(
      {
        classes: [
          {
            name: 'User',
            kind: 'class',
            line: 2,
            endLine: 7,
            extends: 'Illuminate\\Database\\Eloquent\\Model',
            traits: ['HasFactory', 'Notifiable'],
            members: [
              { kind: 'method', name: 'name', detail: ': string', params: null, line: 6, visibility: 'public', isStatic: false },
              { kind: 'const', name: 'ROLE', detail: '= 1', line: 5, visibility: 'public', isStatic: false },
            ],
          },
        ],
        functions: [{ name: 'helper', line: 8, params: '$a', detail: '' }],
      },
      text,
    );
    expect(rows.map((r) => [r.kind, r.name, r.line, r.depth, r.detail])).toEqual([
      ['class', 'User', 2, 0, 'extends Model'],
      ['use', 'HasFactory', 4, 1, 'trait'],
      ['const', 'ROLE', 5, 1, '= 1'],
      ['method', 'name', 6, 1, ': string'],
      ['function', 'helper', 8, 0, ''],
    ]);
    expect(rows.find((r) => r.name === 'ROLE')?.isStatic).toBe(true);
    expect(rows.find((r) => r.name === 'name')?.params).toBe('');
  });
});
