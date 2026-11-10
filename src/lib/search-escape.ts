// A user's search text inside a PostgREST .or(...) filter. Commas and
// parentheses split or group conditions there, so "Smith, Inc" used to break
// the query. A double-quoted value is taken literally; inside it only " and \
// need a backslash.

/** `%query%` as a quoted PostgREST value, safe inside .or(...). */
export function orIlikeContains(query: string): string {
  const escaped = query.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"%${escaped}%"`;
}

/** `col.ilike."%q%"` for each column, joined for .or(...). */
export function orIlikeAny(columns: string[], query: string): string {
  const value = orIlikeContains(query);
  return columns.map(col => `${col}.ilike.${value}`).join(',');
}
