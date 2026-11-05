// Estado persistente de una construcción por spec (.webcode/state.json).
import fs from 'node:fs/promises';
import path from 'node:path';

export function statePath(root) {
  return path.join(root, '.webcode', 'state.json');
}

export async function loadState(root) {
  try {
    return JSON.parse(await fs.readFile(statePath(root), 'utf8'));
  } catch {
    return null;
  }
}

export async function saveState(root, state) {
  const p = statePath(root);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(
    p,
    JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
}
