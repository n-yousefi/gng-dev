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
const outFile = path.resolve(process.argv[3] || path.join(__dirname, '..', 'component-index.json'));

const ignoredDirectories = new Set([
  '.angular',
  '.git',
  '.vscode',
  'coverage',
  'dist',
  'e2e',
  'node_modules',
  'out-tsc',
  'tmp',
]);

function walk(dir, result = []) {
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      if (normalizeAbsolutePath(fullPath).includes('/src/app/projects/')) continue;
      walk(fullPath, result);
    } else if (entry.isFile() && entry.name.endsWith('.component.ts')) {
      result.push({ path: fullPath, kind: 'component' });
    } else if (entry.isFile() && entry.name.endsWith('-column.service.ts')) {
      result.push({ path: fullPath, kind: 'column-service' });
    }
  }
  return result;
}

function normalizePath(filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function normalizeAbsolutePath(filePath) {
  return path.resolve(filePath).replace(/\\/g, '/');
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\r\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readLiteralColumnFields(raw) {
  const text = stripComments(raw);
  const fields = [];
  const seen = new Set();
  let cursor = 0;
  let line = 1;

  for (const match of text.matchAll(/\bname\s*:\s*(['"`])([A-Za-z_$][A-Za-z0-9_$.-]*)\1/g)) {
    for (let index = cursor; index < match.index; index++) {
      if (text.charCodeAt(index) === 10) line++;
    }
    cursor = match.index;
    const name = match[2];
    const key = `${name}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push({ name, line });
  }

  return fields;
}

function readStringProperty(block, propertyName) {
  const regex = new RegExp(`${propertyName}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`, 'm');
  const match = block.match(regex);
  return match ? match[2].trim() : null;
}

function readStringArrayProperty(block, propertyName) {
  const propertyMatch = block.match(new RegExp(`${propertyName}\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'm'));
  if (!propertyMatch) return [];
  return Array.from(propertyMatch[1].matchAll(/(['"`])([\s\S]*?)\1/g), match => match[2].trim()).filter(Boolean);
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

function selectorPrefix(selector) {
  const match = String(selector || '').trim().toLowerCase().match(/^([a-z][a-z0-9]*)-/);
  return match ? `${match[1]}-` : '';
}

function resolveComponentResource(componentPath, resourcePath) {
  if (!resourcePath || !resourcePath.startsWith('.')) return '';
  return normalizePath(path.resolve(path.dirname(componentPath), resourcePath));
}

function conventionalResource(componentPath, extension) {
  const candidate = componentPath.replace(/\.ts$/i, extension);
  return fs.existsSync(candidate) ? normalizePath(candidate) : '';
}

function readImportedColumnServices(text, componentPath) {
  const result = [];
  for (const match of text.matchAll(/from\s+['"]([^'"]+-column\.service)['"]/g)) {
    if (!match[1].startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(componentPath), `${match[1]}.ts`);
    if (fs.existsSync(resolved)) result.push(normalizePath(resolved));
  }
  return Array.from(new Set(result));
}

function getLineNumber(text, searchText) {
  const index = text.indexOf(searchText);
  return index < 0 ? null : text.slice(0, index).split(/\r?\n/).length;
}

function createEntry(item) {
  const raw = fs.readFileSync(item.path, 'utf8');
  const text = stripComments(raw);
  const componentTs = normalizePath(item.path);

  if (item.kind === 'column-service') {
    return {
      selector: null,
      selectorFamily: 'created',
      selectorPrefix: '',
      className: readClassName(text),
      componentTs,
      componentFileName: path.basename(item.path),
      entryType: 'column-service',
      fields: readLiteralColumnFields(raw),
    };
  }

  const block = extractComponentBlock(text);
  if (!block) return null;

  const selector = readStringProperty(block, 'selector');
  if (!selector) return null;
  const configuredTemplate = readStringProperty(block, 'templateUrl');
  const configuredStyles = readStringArrayProperty(block, 'styleUrls');

  return {
    selector,
    selectorFamily: 'created',
    selectorPrefix: selectorPrefix(selector),
    className: readClassName(text),
    componentTs,
    componentFileName: path.basename(item.path),
    selectorLine: getLineNumber(raw, selector),
    templateUrl: resolveComponentResource(item.path, configuredTemplate) || conventionalResource(item.path, '.html'),
    styleUrls: configuredStyles.map(stylePath => resolveComponentResource(item.path, stylePath)).filter(Boolean),
    relatedColumnServices: readImportedColumnServices(text, item.path),
  };
}

function readAngularWorkspace() {
  const angularJsonPath = path.join(projectRoot, 'angular.json');
  if (!fs.existsSync(angularJsonPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(angularJsonPath, 'utf8'));
  } catch (error) {
    console.warn(`Could not parse ${angularJsonPath}: ${error.message || error}`);
    return null;
  }
}

function getWorkspaceSourceRoots() {
  const workspace = readAngularWorkspace();
  const roots = [];
  for (const project of Object.values(workspace?.projects || {})) {
    if (!project || project.projectType === 'application' && String(project.root || '').startsWith('e2e')) continue;
    const sourceRoot = project.sourceRoot || (project.root ? path.join(project.root, 'src') : '');
    if (!sourceRoot) continue;
    const fullPath = path.resolve(projectRoot, sourceRoot);
    if (fs.existsSync(fullPath)) roots.push(fullPath);
  }
  return uniqueExistingPaths(roots);
}

function uniqueExistingPaths(paths) {
  const seen = new Set();
  const result = [];
  for (const item of paths) {
    const normalized = normalizeAbsolutePath(item);
    if (seen.has(normalized) || !fs.existsSync(item)) continue;
    seen.add(normalized);
    result.push(item);
  }
  return result;
}

function getSourceRoots() {
  const workspaceRoots = getWorkspaceSourceRoots();
  if (workspaceRoots.length) return workspaceRoots;

  return uniqueExistingPaths([
    path.join(projectRoot, 'projects', 'gig-app-sl', 'src', 'lib'),
    path.join(projectRoot, 'src'),
    path.join(projectRoot, 'projects'),
    projectRoot,
  ]);
}

function main() {
  const sourceRoots = getSourceRoots();
  if (!sourceRoots.length) {
    console.error(`No Angular source roots found under: ${projectRoot}`);
    process.exit(1);
  }

  const allItems = sourceRoots.flatMap(sourceRoot => walk(sourceRoot));
  const componentEntries = allItems.filter(i => i.kind === 'component').map(createEntry).filter(Boolean);
  const columnServiceEntries = allItems.filter(i => i.kind === 'column-service').map(createEntry).filter(Boolean);

  const entries = [...componentEntries, ...columnServiceEntries]
    .sort((a, b) => (a.selector || a.className || '').localeCompare(b.selector || b.className || ''));

  const counts = entries.reduce((acc, entry) => {
    acc[entry.selectorFamily] = (acc[entry.selectorFamily] || 0) + 1;
    return acc;
  }, {});

  const payload = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    projectRoot: projectRoot.replace(/\\/g, '/'),
    sourceRoots: sourceRoots.map(sourceRoot => normalizePath(sourceRoot)),
    counts,
    components: entries,
  };

  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Indexed ${entries.length} components (${componentEntries.length} components, ${columnServiceEntries.length} column services).`);
  console.log(`Scanned roots: ${sourceRoots.map(sourceRoot => normalizePath(sourceRoot)).join(', ')}`);
  console.log(`Created/app components: ${counts.created || 0}. Framework components: ${counts.framework || 0}. Unknown: ${counts.unknown || 0}.`);
  console.log(`Wrote ${outFile}`);
}

main();
