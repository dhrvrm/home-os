/** Actual local D1 counters, including point authority reads. No seed writes. */
export function measuredStatementDB(database: D1Database) {
  const records: { sql: string; values: unknown[]; rowsRead: number; rowsWritten: number }[] = [];
  const originals = new WeakMap<object, { statement: D1PreparedStatement; sql: string; values: unknown[] }>();
  function record(sql: string, values: unknown[], result: D1Result) {
    records.push({ sql, values, rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written });
  }
  function wrap(original: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement {
    const wrapped = new Proxy(original, { get(target, key) {
      if (key === 'bind') return (...bindings: unknown[]) => wrap(target.bind(...bindings), sql, bindings);
      if (key === 'first') return async (column?: string) => {
        const result = await target.all<Record<string, unknown>>();
        record(sql, values, result);
        return column === undefined ? result.results[0] ?? null : result.results[0]?.[column] ?? null;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    originals.set(wrapped, { statement: original, sql, values });
    return wrapped;
  }
  const wrapped = new Proxy(database, { get(target, key) {
    if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      const sources = statements.map(item => originals.get(item)!);
      const results = await target.batch(sources.map(item => item.statement));
      results.forEach((result, i) => record(sources[i]!.sql, sources[i]!.values, result));
      return results;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { database: wrapped, records, rowsRead: () => records.reduce((sum, row) => sum + row.rowsRead, 0) };
}
