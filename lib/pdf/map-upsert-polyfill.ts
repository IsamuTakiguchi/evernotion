/**
 * Polyfill for the TC39 "Map upsert" proposal — Map/WeakMap `getOrInsert` and
 * `getOrInsertComputed`.
 *
 * pdf.js v6 calls these throughout its rendering and worker code, but they have
 * not shipped in browsers yet (Chromium 141 and Node 22 both lack them), so
 * without this the viewer fails with
 *   "this[#methodPromises].getOrInsertComputed is not a function"
 * from inside page.render() — and because that rejection happens in pdf.js's
 * own internals, the render promise never settles and the page silently stops
 * halfway with no text layer.
 *
 * Import this before loading pdf.js, on both the server and the client.
 */

type UpsertMap<K, V> = {
  has(key: K): boolean;
  get(key: K): V | undefined;
  set(key: K, value: V): unknown;
  getOrInsert?(key: K, value: V): V;
  getOrInsertComputed?(key: K, callback: (key: K) => V): V;
};

function install<K, V>(proto: UpsertMap<K, V>) {
  if (typeof proto.getOrInsert !== 'function') {
    Object.defineProperty(proto, 'getOrInsert', {
      value: function (this: UpsertMap<K, V>, key: K, value: V): V {
        if (this.has(key)) return this.get(key) as V;
        this.set(key, value);
        return value;
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  if (typeof proto.getOrInsertComputed !== 'function') {
    Object.defineProperty(proto, 'getOrInsertComputed', {
      value: function (this: UpsertMap<K, V>, key: K, callback: (key: K) => V): V {
        if (this.has(key)) return this.get(key) as V;
        const value = callback(key);
        this.set(key, value);
        return value;
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

install(Map.prototype as unknown as UpsertMap<unknown, unknown>);
install(WeakMap.prototype as unknown as UpsertMap<object, unknown>);

export {};
