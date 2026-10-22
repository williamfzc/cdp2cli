// Metadata-only application inspection for agent-led capability discovery.
// Always closes its connection; candidates are never promoted to verified tools.
import { AppConnection } from './connection.mjs';
import { validateApp } from './registry.mjs';
import { readJSONFile } from './project-files.mjs';

export async function inspectApplication(appFile, { offset = 0, pageSize = 50 } = {}) {
  const { value: app } = await readJSONFile(appFile);
  validateApp(app);
  const connection = new AppConnection(app);
  try { return await connection.inspect({ offset, pageSize }); }
  finally { await connection.close(); }
}
