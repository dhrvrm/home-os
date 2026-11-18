/** Count binding requests against local D1; optional conservative mode counts every batch statement. */
export function countedD1(database: D1Database, limit = 50, conservative = false) {
  let calls = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();
  function take() {
    calls++;
    if (calls > limit)
      throw new Error(`D1 invocation query budget exceeded: ${calls}`);
  }
  function statement(original: D1PreparedStatement): D1PreparedStatement {
    const wrapped = new Proxy(original, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) => statement(target.bind(...values));
        const value = Reflect.get(target, key, target);
        if (["first", "all", "run", "raw"].includes(String(key)))
          return (...args: unknown[]) => {
            take();
            return Reflect.apply(value, target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, original);
    return wrapped;
  }
  const wrapped = new Proxy(database, {
    get(target, key) {
      if (key === "prepare")
        return (query: string) => statement(target.prepare(query));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          if (conservative) for (const _statement of statements) take();
          else take();
          return target.batch(
            statements.map((item) => originals.get(item) ?? item),
          );
        };
      const value = Reflect.get(target, key, target);
      if (key === "exec")
        return (...args: unknown[]) => {
          take();
          return Reflect.apply(value, target, args);
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: wrapped, calls: () => calls };
}

/** Count every KV binding operation without inspecting keys or reusable proofs. */
export function countedKV(namespace: KVNamespace, limit = 50) {
  let calls = 0;
  const wrapped = new Proxy(namespace, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      calls++;
      if (calls > limit) throw new Error(`KV invocation request budget exceeded: ${calls}`);
      return Reflect.apply(value, target, args);
    };
  } });
  return { namespace: wrapped, calls: () => calls };
}
