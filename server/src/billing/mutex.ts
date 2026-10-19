/**
 * Ejecuta tareas de a una por clave, en orden de llegada. La facturación lo usa para
 * pedir número y CAE de a una factura por punto de venta, porque ARCA exige que cada
 * número sea el siguiente al último autorizado.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/**
 * Mutex de ARCA de todo el proceso: lo comparten el proceso de facturación y los
 * reintentos manuales, para que nunca pidan número y CAE a la vez en un punto de venta.
 */
export const arcaMutex = new KeyedMutex();
