/**
 * Signal que se aborta a los `ms` con un error "TimeoutError" (RNF-07). A diferencia
 * de AbortSignal.timeout, usa setTimeout, así que los tests lo controlan con timers
 * falsos. El timer no mantiene vivo el proceso.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Sin respuesta en ${ms} ms`, 'TimeoutError'));
  }, ms);
  timer.unref?.();
  return controller.signal;
}
