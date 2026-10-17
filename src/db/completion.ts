// What SQL completion should offer at the cursor, from the statement around it: tables after
// FROM / JOIN / UPDATE / INTO, a table's (or alias's) columns after "x.", a schema's tables after
// "schema.", and otherwise the columns of the tables the statement uses.

/** A table the statement uses, with its alias if any (`FROM users u`, `JOIN orders AS o`). */
export interface TableRef {
  schema?: string;
  table: string;
  alias?: string;
}

export type SqlContext =
  /** After FROM, JOIN, UPDATE, INTO, TABLE: table names. */
  | { kind: 'tables' }
  /** After "x.": the columns of table or alias x, or the tables of schema x. */
  | { kind: 'member'; qualifier: string }
  /** Anywhere else: columns of the statement's tables, then tables, functions and keywords. */
  | { kind: 'columns' };

const unquote = (name: string) => name.replace(/^[`"[]|[`"\]]$/g, '');
/** A name, plain or quoted ("Order Items", `users`, [users]). */
const NAME = String.raw`(?:"[^"]+"|\`[^\`]+\`|\[[^\]]+\]|[\w$]+)`;
/** Words that end a FROM list or can't be an alias. */
const CLAUSE = /^(where|join|inner|left|right|full|cross|outer|on|using|group|order|having|limit|offset|union|except|intersect|returning|set|values|natural|lateral|as|window|for|fetch)$/i;

/** The tables a statement reads or writes, with their aliases. */
export function tableRefs(statement: string): TableRef[] {
  const refs: TableRef[] = [];
  // Strip strings and comments so their contents can't look like table names, and set quoted
  // names aside ("Order Items" must not read as ORDER).
  const quoted: string[] = [];
  const sql = statement
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/"[^"]+"|`[^`]+`|\[[^\]]+\]/g, (q) => `__q${quoted.push(q) - 1}__`);
  const restore = (name: string) => unquote(name.replace(/^__q(\d+)__$/, (_, i) => quoted[Number(i)]));
  const one = new RegExp(String.raw`^\s*(?:(${NAME})\s*\.\s*)?(${NAME})(?:\s+(?:as\s+)?(${NAME}))?`, 'i');
  const add = (part: string) => {
    const m = one.exec(part);
    if (!m || m[2].startsWith('(')) return;
    const alias = m[3] && !CLAUSE.test(m[3]) ? restore(m[3]) : undefined;
    refs.push({ schema: m[1] ? restore(m[1]) : undefined, table: restore(m[2]), alias });
  };
  // FROM a x, b y …: everything up to the next clause, split on commas.
  for (const m of sql.matchAll(/\bfrom\s+([\s\S]*?)(?=\b(?:where|join|inner|left|right|full|cross|group|order|having|limit|offset|union|except|intersect|returning|window|for)\b|;|\(|\)|$)/gi)) {
    m[1].split(',').forEach(add);
  }
  for (const m of sql.matchAll(new RegExp(String.raw`\b(?:join|update|into)\s+((?:${NAME}\s*\.\s*)?${NAME}(?:\s+(?:as\s+)?${NAME})?)`, 'gi'))) add(m[1]);
  // Subqueries aren't tables; a name can appear twice (self-join): keep each alias.
  const seen = new Set<string>();
  return refs.filter((r) => !/^(select|lateral)$/i.test(r.table) && !seen.has(`${r.schema}.${r.table}.${r.alias}`) && seen.add(`${r.schema}.${r.table}.${r.alias}`));
}

/** What to offer for the text of the statement before the cursor. */
export function sqlContext(before: string): SqlContext {
  const qualified = new RegExp(String.raw`(${NAME})\s*\.\s*[\w$]*$`).exec(before);
  if (qualified) return { kind: 'member', qualifier: unquote(qualified[1]) };
  // The last keyword before the word being typed (strings and comments removed).
  const plain = before.replace(/'(?:[^']|'')*'?/g, "''").replace(/--[^\n]*/g, ' ');
  const words = plain.replace(/[\w$]*$/, '').match(/[A-Za-z_]+|[,()=<>]/g) ?? [];
  const last = (words[words.length - 1] ?? '').toLowerCase();
  if (['from', 'join', 'update', 'into', 'table'].includes(last)) return { kind: 'tables' };
  // FROM a, | : another table.
  if (last === ',') {
    const kw = [...words].reverse().find((w) => /^[a-z_]+$/i.test(w) && /^(select|from|where|set|by|on|and|or|values|returning|having)$/i.test(w));
    if (kw?.toLowerCase() === 'from') return { kind: 'tables' };
  }
  return { kind: 'columns' };
}

/** The table a qualifier ("u" or "users" in "u.") refers to in the statement. */
export function resolveQualifier(refs: TableRef[], qualifier: string): TableRef | undefined {
  const q = qualifier.toLowerCase();
  return refs.find((r) => r.alias?.toLowerCase() === q) ?? refs.find((r) => r.table.toLowerCase() === q);
}
