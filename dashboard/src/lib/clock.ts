import { API_MODE } from '../api'
import { mockControls } from '../api/mockAdapter'

/** Reloj de la UI: en mock sigue la simulación; en HTTP es el reloj real. */
export function now(): number {
  return API_MODE === 'mock' ? mockControls.getNow() : Date.now()
}
