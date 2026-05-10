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

function selectorFamily(selector) {
  const normalized = (selector || '').toLowerCase();
  if (frameworkPrefixes.some(prefix => normalized.startsWith(prefix))) return 'framework';
  if (createdPrefixes.some(prefix => normalized.startsWith(prefix))) return 'created';
  return 'unknown';
}

function createEntry(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const text = stripComments(raw);
  const block = extractComponentBlock(text);
  if (!block) return null;

  const selector = readStringProperty(block, 'selector');
  if (!selector) return null;

  const componentTs = normalizePath(file);
  const family = selectorFamily(selector);

  return {
    selector,
    selectorFamily: family,
    className: readClassName(text),
    componentTs,
    componentFileName: path.basename(file),
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
    acc[entry.selectorFamily] = (acc[entry.selectorFamily] || 0) + 1;
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
