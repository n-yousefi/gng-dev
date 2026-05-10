#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const defaultProjectRoot = process.env.CLIENT_APP_ROOT || '';
const projectRootArg = process.argv[2] || defaultProjectRoot;
if (!projectRootArg) {
  console.error('Usage: node scripts/build-component-index.js <ClientAppRoot> [outFile]');
  process.exit(1);
}

const projectRoot = path.resolve(projectRootArg);
const sourceRoot = path.join(projectRoot, 'projects', 'gig-app-sl', 'src', 'lib');
const outFile = path.resolve(process.argv[3] || path.join(__dirname, '..', 'component-index.json'));

const frameworkPrefixes = ['gng-', 'gig-', 'gsm-'];
const createdPrefixes = ['sl-', 'app-'];

function walk(dir, result = []) {
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(fullPath, result);
    } else if (entry.isFile() && entry.name.endsWith('.component.ts')) {
      result.push(fullPath);
    }
  }
  return result;
}

function normalizePath(filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readStringProperty(block, propertyName) {
  const regex = new RegExp(`${propertyName}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`, 'm');
  const match = block.match(regex);
  return match ? match[2].trim() : null;
}

function readStringArrayProperty(block, propertyName) {
  const regex = new RegExp(`${propertyName}\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'm');
  const match = block.match(regex);
  if (!match) return [];
  const items = [];
  const itemRegex = /(['"`])([\s\S]*?)\1/g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(match[1])) !== null) {
    items.push(itemMatch[2].trim());
  }
  return items;
}

function readClassName(text) {
  const match = text.match(/export\s+class\s+([A-Za-z0-9_]+)/);
  return match ? match[1] : null;
}

function extractComponentBlock(text) {
  const decoratorIndex = text.indexOf('@Component');
  if (decoratorIndex < 0) return null;
  const openIndex = text.indexOf('{', decoratorIndex);
  if (openIndex < 0) return null;
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const char = text[i];
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth === 0) return text.slice(openIndex + 1, i);
  }
  return null;
}

function readTemplateHtml(componentFile, templateUrl, inlineTemplate) {
  if (inlineTemplate) return inlineTemplate;
  if (!templateUrl) return null;
  const fullPath = path.resolve(path.dirname(componentFile), templateUrl);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, 'utf8');
}

function selectorFamily(selector) {
  const normalized = (selector || '').toLowerCase();
  if (frameworkPrefixes.some(prefix => normalized.startsWith(prefix))) return 'framework';
  if (createdPrefixes.some(prefix => normalized.startsWith(prefix))) return 'created';
  return 'unknown';
}

function routeHint(relativeComponentPath) {
  return relativeComponentPath
    .replace(/^projects\/gig-app-sl\/src\/lib\//, '')
    .replace(/\/[^/]+\.component\.ts$/, '');
}

function createEntry(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const text = stripComments(raw);
  const block = extractComponentBlock(text);
  if (!block) return null;

  const selector = readStringProperty(block, 'selector');
  if (!selector) return null;

  const templateUrl = readStringProperty(block, 'templateUrl');
  const inlineTemplate = readStringProperty(block, 'template');
  const styleUrls = readStringArrayProperty(block, 'styleUrls');
  const templateFullPath = templateUrl ? path.resolve(path.dirname(file), templateUrl) : null;
  const componentTs = normalizePath(file);
  const templatePath = templateFullPath ? normalizePath(templateFullPath) : null;
  const family = selectorFamily(selector);

  return {
    selector,
    selectorFamily: family,
    ownerType: family,
    className: readClassName(text),
    componentTs,
    componentFileName: path.basename(file),
    componentDir: path.dirname(componentTs).replace(/\\/g, '/'),
    routeHint: routeHint(componentTs),
    templateUrl: templatePath,
    templateFileName: templatePath ? path.basename(templatePath) : null,
    styleUrls: styleUrls.map(styleUrl => normalizePath(path.resolve(path.dirname(file), styleUrl))),
    templateHtml: readTemplateHtml(file, templateUrl, inlineTemplate),
  };
}

function main() {
  if (!fs.existsSync(sourceRoot)) {
    console.error(`Source root not found: ${sourceRoot}`);
    process.exit(1);
  }

  const entries = walk(sourceRoot)
    .map(createEntry)
    .filter(Boolean)
    .sort((a, b) => a.selector.localeCompare(b.selector));

  const counts = entries.reduce((acc, entry) => {
    acc[entry.ownerType] = (acc[entry.ownerType] || 0) + 1;
    return acc;
  }, {});

  const payload = {
    generatedAt: new Date().toISOString(),
    projectRoot: projectRoot.replace(/\\/g, '/'),
    counts,
    components: entries,
  };

  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Indexed ${entries.length} components.`);
  console.log(`Created/app components: ${counts.created || 0}. Framework components: ${counts.framework || 0}. Unknown: ${counts.unknown || 0}.`);
  console.log(`Wrote ${outFile}`);
}

main();
