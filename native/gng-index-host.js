const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOST_DIR = __dirname;
const EXTENSION_ROOT = path.resolve(HOST_DIR, '..');
const ENV_PATH = path.join(EXTENSION_ROOT, '.env');
const LOCAL_INDEX_PATH = path.join(EXTENSION_ROOT, 'component-index.json');
const INDEX_CACHE_DIR = path.join(EXTENSION_ROOT, '.index-cache');
const INDEX_SCRIPT = path.join(EXTENSION_ROOT, 'scripts', 'build-component-index.js');

function readEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    env[key] = value;
  }
  return env;
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch (_error) {
    return text.replace(/\/$/, '').toLowerCase();
  }
}

function normalizeName(value) {
  return String(value || 'project')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'project';
}

function createProject(id, config, useLegacyIndexFile = false) {
  const clientAppRoot = config.CLIENT_APP_ROOT || config.APP_ROOT || config.ROOT;
  if (!clientAppRoot) return null;
  const name = config.NAME || id;
  const normalizedId = normalizeName(id || name);
  return {
    id: normalizedId,
    name,
    baseUrl: config.BASE_URL || config.URL || '',
    normalizedBaseUrl: normalizeUrl(config.BASE_URL || config.URL || ''),
    clientAppRoot: path.resolve(clientAppRoot),
    outFile: useLegacyIndexFile ? LOCAL_INDEX_PATH : path.join(INDEX_CACHE_DIR, `${normalizedId}.json`),
  };
}

function parseListProjects(env) {
  const result = [];
  if (!env.GNG_PROJECTS) return result;

  for (const item of env.GNG_PROJECTS.split(';')) {
    const parts = item.split('|').map(part => part.trim()).filter(Boolean);
    if (parts.length < 3) continue;
    result.push(
      createProject(parts[0], {
        NAME: parts[0],
        BASE_URL: parts[1],
        CLIENT_APP_ROOT: parts.slice(2).join('|'),
      }),
    );
  }
  return result.filter(Boolean);
}

function parsePrefixedProjects(env) {
  const configs = new Map();
  for (const [key, value] of Object.entries(env)) {
    const parsed = parseProjectEnvKey(key);
    if (!parsed) continue;
    const { id, field } = parsed;
    if (!configs.has(id)) configs.set(id, {});
    configs.get(id)[field] = value;
  }
  return Array.from(configs, ([id, config]) => createProject(id, config)).filter(Boolean);
}

function parseProjectEnvKey(key) {
  const prefix = 'PROJECT_';
  if (!key.startsWith(prefix)) return null;

  for (const field of ['CLIENT_APP_ROOT', 'BASE_URL', 'APP_ROOT', 'NAME', 'URL', 'ROOT']) {
    const suffix = `_${field}`;
    if (!key.endsWith(suffix)) continue;
    const id = key.slice(prefix.length, -suffix.length);
    return id ? { id, field } : null;
  }

  return null;
}

function getProjects() {
  const env = readEnv(ENV_PATH);
  const projects = [...parseListProjects(env), ...parsePrefixedProjects(env)];

  if (env.CLIENT_APP_ROOT) {
    projects.push(
      createProject(
        env.PROJECT_NAME || 'default',
        {
          NAME: env.PROJECT_NAME || 'Default',
          BASE_URL: env.CLIENT_APP_BASE_URL || env.BASE_URL || '',
          CLIENT_APP_ROOT: env.CLIENT_APP_ROOT,
        },
        projects.length === 0,
      ),
    );
  }

  if (!projects.length) {
    throw new Error(`No project roots are configured in ${ENV_PATH}. Copy .env.sample to .env and configure CLIENT_APP_ROOT or PROJECT_* entries.`);
  }

  return projects;
}

function selectProject(pageUrl) {
  const projects = getProjects();
  const normalizedPageUrl = normalizeUrl(pageUrl);
  const matches = normalizedPageUrl
    ? projects
        .filter(project => project.normalizedBaseUrl && normalizedPageUrl.startsWith(project.normalizedBaseUrl))
        .sort((a, b) => b.normalizedBaseUrl.length - a.normalizedBaseUrl.length)
    : [];

  if (matches.length) return matches[0];
  if (projects.length === 1) return projects[0];

  const configured = projects
    .map(project => `${project.name}${project.baseUrl ? ` (${project.baseUrl})` : ''}`)
    .join(', ');
  throw new Error(`No configured project matches ${pageUrl || 'the inspected page URL'}. Configured projects: ${configured}`);
}

function ensureIndexScript() {
  if (!fs.existsSync(INDEX_SCRIPT)) {
    throw new Error(`Index script not found: ${INDEX_SCRIPT}`);
  }
}

function readIndex(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function projectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    baseUrl: project.baseUrl,
    clientAppRoot: project.clientAppRoot.replace(/\\/g, '/'),
  };
}

function buildIndex(project) {
  ensureIndexScript();
  fs.mkdirSync(path.dirname(project.outFile), { recursive: true });

  const result = spawnSync(process.execPath, [INDEX_SCRIPT, project.clientAppRoot, project.outFile], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Index script exited with ${result.status}.`);
  }

  const index = readIndex(project.outFile);
  return {
    ok: true,
    count: Array.isArray(index.components) ? index.components.length : 0,
    outFile: project.outFile.replace(/\\/g, '/'),
    project: projectSummary(project),
    generatedAt: index.generatedAt || new Date().toISOString(),
    index,
    stdout: result.stdout,
  };
}

function getIndex(project) {
  if (!fs.existsSync(project.outFile)) return buildIndex(project);
  const index = readIndex(project.outFile);
  return {
    ok: true,
    count: Array.isArray(index.components) ? index.components.length : 0,
    outFile: project.outFile.replace(/\\/g, '/'),
    project: projectSummary(project),
    generatedAt: index.generatedAt || '',
    index,
    cached: true,
  };
}

function sendMessage(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(header);
  process.stdout.write(json);
}

function handleMessage(message) {
  if (!message || !['getIndex', 'rebuildIndex'].includes(message.type)) {
    return { ok: false, error: 'Unsupported native message type.' };
  }

  const project = selectProject(message.pageUrl);
  return message.type === 'rebuildIndex' ? buildIndex(project) : getIndex(project);
}

let input = Buffer.alloc(0);

process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (input.length < 4 + length) return;
    const body = input.slice(4, 4 + length).toString('utf8');
    input = input.slice(4 + length);

    try {
      sendMessage(handleMessage(JSON.parse(body)));
    } catch (error) {
      sendMessage({ ok: false, error: error.message || String(error) });
    }
  }
});
