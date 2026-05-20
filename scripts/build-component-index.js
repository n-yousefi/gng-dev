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
      result.push(fullPath);
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

function selectorPrefix(selector) {
  const match = String(selector || '').trim().toLowerCase().match(/^([a-z][a-z0-9]*)-/);
  return match ? `${match[1]}-` : '';
}

function createEntry(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const text = stripComments(raw);
  const block = extractComponentBlock(text);
  if (!block) return null;

  const selector = readStringProperty(block, 'selector');
  if (!selector) return null;

  const componentTs = normalizePath(file);

  return {
    selector,
    selectorFamily: 'created',
    selectorPrefix: selectorPrefix(selector),
    className: readClassName(text),
    componentTs,
    componentFileName: path.basename(file),
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

function preferEntry(current, candidate) {
  if (!current) return candidate;
  const currentPath = current.componentTs || '';
  const candidatePath = candidate.componentTs || '';
  const currentIsMirror = currentPath.includes('/src/app/projects/');
  const candidateIsMirror = candidatePath.includes('/src/app/projects/');
  if (currentIsMirror !== candidateIsMirror) return candidateIsMirror ? current : candidate;
  return candidatePath.length < currentPath.length ? candidate : current;
}

function dedupeEntries(entries) {
  const bySelector = new Map();
  for (const entry of entries) {
    const key = entry.selector.toLowerCase();
    bySelector.set(key, preferEntry(bySelector.get(key), entry));
  }
  return Array.from(bySelector.values());
}

function main() {
  const sourceRoots = getSourceRoots();
  if (!sourceRoots.length) {
    console.error(`No Angular source roots found under: ${projectRoot}`);
    process.exit(1);
  }

  const entries = dedupeEntries(sourceRoots.flatMap(sourceRoot => walk(sourceRoot))
    .map(createEntry)
    .filter(Boolean))
    .sort((a, b) => a.selector.localeCompare(b.selector));

  const counts = entries.reduce((acc, entry) => {
    acc[entry.selectorFamily] = (acc[entry.selectorFamily] || 0) + 1;
    return acc;
  }, {});

  const payload = {
    generatedAt: new Date().toISOString(),
    projectRoot: projectRoot.replace(/\\/g, '/'),
    sourceRoots: sourceRoots.map(sourceRoot => normalizePath(sourceRoot)),
    counts,
    components: entries,
  };

  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Indexed ${entries.length} components.`);
  console.log(`Scanned roots: ${sourceRoots.map(sourceRoot => normalizePath(sourceRoot)).join(', ')}`);
  console.log(`Created/app components: ${counts.created || 0}. Framework components: ${counts.framework || 0}. Unknown: ${counts.unknown || 0}.`);
  console.log(`Wrote ${outFile}`);
}

main();
