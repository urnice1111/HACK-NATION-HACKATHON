/** Utilidades en memoria compartidas por el servidor, el despachador y las herramientas de voz. */

/** Serializa el trabajo por clave (teléfono, seguimiento): dos tareas con la misma clave no se pisan. */
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

/** Map que olvida la entrada más antigua al pasar de `capacity`; para deduplicar sin crecer sin límite. */
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
