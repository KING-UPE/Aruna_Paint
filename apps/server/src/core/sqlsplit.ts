/**
 * Splits a migration file into single statements (Prisma runs one statement per raw call).
 * Semicolons inside quotes, quoted names, comments and $$ function bodies don't split.
 */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const take = (end: number) => {
    cur += sql.slice(i, end);
    i = end;
  };
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      take(nl < 0 ? sql.length : nl);
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      take(end < 0 ? sql.length : end + 2);
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      take(Math.min(sql.length, j + 1));
    } else if (c === '$' && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      take(end < 0 ? sql.length : end + tag.length);
    } else if (c === ';') {
      out.push(cur);
      cur = '';
      i++;
    } else {
      take(i + 1);
    }
  }
  out.push(cur);
  // Drop what is only comments or blank.
  const bare = (s: string) =>
    s
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
  return out.map((s) => s.trim()).filter((s) => bare(s).length > 0);
}
