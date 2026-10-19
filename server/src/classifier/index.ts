import type { Config } from '../config.js';
import { ClaudeClassifier } from './claude.js';
import { MockClassifier } from './mock.js';
import type { AttachmentClassifier } from './types.js';

export * from './types.js';

/** Clasificador por nombre de archivo en modo mock (RF-187); Claude fuera de él. */
export function createClassifier(config: Config): AttachmentClassifier {
  if (config.mockMode) return new MockClassifier();
  if (!config.anthropicApiKey) throw new Error('Falta ANTHROPIC_API_KEY.');
  // RNF-08: la API key sale de la variable de entorno.
  return new ClaudeClassifier({ apiKey: config.anthropicApiKey, issuerCuit: config.arca.cuit });
}
