import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

const schema = yaml.CORE_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: () => ({ dynamic: true }) }));
const absent = reason => ({ public: { available: false, reason } });

export function selectPublicModel(document) {
  if (!Array.isArray(document)) throw new Error('Invalid host profile');
  const rows = new Map();
  for (const patch of document) {
    if (Array.isArray(patch?.insert)) for (const row of patch.insert) if (row?.id) rows.set(row.id, row);
    if (patch?.id) rows.set(patch.id, patch);
  }
  const selection = rows.get('agent-default-model');
  const providerRow = rows.get('llm-pi-ai');
  const provider = selection?.config?.provider;
  const model = selection?.config?.model;
  if (selection?.disabled || providerRow?.disabled || typeof provider !== 'string' || provider.length > 150 || typeof model !== 'string' || !model || model.length > 150) throw new Error('No selected provider/model');
  const candidate = providerRow?.config?.providers?.[provider];
  if (!candidate || !['anthropic-messages', 'openai-completions', 'openai-responses'].includes(candidate.api)) throw new Error('Unsupported selected provider protocol');
  if (!/^[A-Z][A-Z0-9_]{0,149}$/.test(candidate.apiKeyEnv ?? '')) throw new Error('Invalid key reference');
  const endpoint = new URL(candidate.baseURL);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid provider endpoint');
  if (!Array.isArray(candidate.models) || !candidate.models.some(row => row?.id === model)) throw new Error('Selected model not in provider');
  return { provider, model, providerConfig: { api: candidate.api, apiKeyEnv: candidate.apiKeyEnv, baseURL: endpoint.href.replace(/\/$/, ''), models: [{ id: model }] } };
}

export async function readAuthorizedHostModel({ enabled = false, home = homedir(), read = readFile } = {}) {
  if (!enabled) return absent('未启用本机模型配置');
  try {
    // Parse !!js as an inert marker; never execute host profile code.
    const document = yaml.load(await read(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8'), { schema });
    const selected = selectPublicModel(document);
    const credentials = yaml.load(await read(join(home, '.dsh/.credentials.yaml'), 'utf8'), { schema: yaml.CORE_SCHEMA });
    const key = credentials?.refs?.[selected.providerConfig.apiKeyEnv];
    if (typeof key !== 'string' || !key.trim()) return absent('所选模型缺少可用凭据');
    return { ...selected, key: key.trim(), public: { available: true, model: selected.model } };
  } catch { return absent('本机模型配置暂不可用，请检查 Harness 的模型设置'); }
}
