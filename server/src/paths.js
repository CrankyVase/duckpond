import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_MODEL_ROOT = join(PROJECT_ROOT, 'models');
export const DEFAULT_HF_HOME = join(DEFAULT_MODEL_ROOT, 'huggingface');
const bundledHf = join(PROJECT_ROOT, '.bridge-venv', 'bin', 'hf');
export const DEFAULT_HF_CLI = existsSync(bundledHf) ? bundledHf : 'hf';
export const DEFAULT_ROUTER_INI = join(PROJECT_ROOT, 'bridge', 'models.ini');
