/** In-memory utilities shared by the server, the dispatcher and the voice tools. */

/** Serializes work per key (phone, follow-up): two tasks with the same key never overlap. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/** Map that forgets its oldest entry past `capacity`; for deduplicating without unbounded growth. */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly capacity = 5000) {
    super();
  }

  override set(key: K, value: V): this {
    super.set(key, value);
    if (this.size > this.capacity) this.delete(this.keys().next().value!);
    return this;
  }
}
