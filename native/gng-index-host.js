const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOST_DIR = __dirname;
const EXTENSION_ROOT = path.resolve(HOST_DIR, '..');
const ENV_PATH = path.join(EXTENSION_ROOT, '.env');
const LOCAL_INDEX_PATH = path.join(EXTENSION_ROOT, 'component-index.json');

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

function getConfig() {
  const env = readEnv(ENV_PATH);
  if (!env.TOTALSALES_ROOT && !env.CLIENT_APP_ROOT) {
    throw new Error(`TOTALSALES_ROOT or CLIENT_APP_ROOT is missing in ${ENV_PATH}. Copy .env.sample to .env and configure it.`);
  }

  const totalSalesRoot = env.TOTALSALES_ROOT ? path.resolve(env.TOTALSALES_ROOT) : null;
  const clientAppRoot = env.CLIENT_APP_ROOT
    ? path.resolve(env.CLIENT_APP_ROOT)
    : path.join(totalSalesRoot, 'Gng.TotalSales.UI', 'GIG.App.Sl', 'ClientApp');
  const indexScript = env.GNG_COMPONENT_INDEX_SCRIPT
    ? path.resolve(env.GNG_COMPONENT_INDEX_SCRIPT)
    : path.join(totalSalesRoot || path.resolve(clientAppRoot, '..', '..', '..'), 'Tools', 'gng-component-index.js');

  return {
    totalSalesRoot: totalSalesRoot || path.resolve(clientAppRoot, '..', '..', '..'),
    clientAppRoot,
    indexScript,
    outFile: LOCAL_INDEX_PATH,
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
  if (!message || message.type !== 'rebuildIndex') {
    return { ok: false, error: 'Unsupported native message type.' };
  }

  const config = getConfig();
  if (!fs.existsSync(config.indexScript)) {
    return { ok: false, error: `Index script not found: ${config.indexScript}` };
  }

  const result = spawnSync(process.execPath, [config.indexScript, config.clientAppRoot, config.outFile], {
    cwd: config.totalSalesRoot,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr || result.stdout || `Index script exited with ${result.status}.`,
    };
  }

  const index = JSON.parse(fs.readFileSync(config.outFile, 'utf8'));
  return {
    ok: true,
    count: Array.isArray(index.components) ? index.components.length : 0,
    outFile: config.outFile.replace(/\\/g, '/'),
    projectRoot: config.clientAppRoot.replace(/\\/g, '/'),
    generatedAt: index.generatedAt || new Date().toISOString(),
    stdout: result.stdout,
  };
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
