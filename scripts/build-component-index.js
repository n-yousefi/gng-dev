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
  const seenNames = new Set();
  const pattern = /(?:\bname\s*:\s*|\bgetDefault[A-Za-z0-9_]*Column\s*\(\s*)(['"`])([A-Za-z0-9_$.-]+)\1|^\s*(?:public\s+|private\s+|protected\s+)?(get[A-Za-z0-9_]*Columns[A-Za-z0-9_]*)\s*\(/gm;
  let cursor = 0;
  let line = 1;

  for (const match of text.matchAll(pattern)) {
    for (let index = cursor; index < match.index; index++) {
      if (text.charCodeAt(index) === 10) line++;
    }
    cursor = match.index;
    const name = match[2] || match[3];
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);
    fields.push(`${name}:${line}`);
  }

  return fields;
}

function readImportedColumnServicesInfo(text, componentPath) {
  const classToPath = new Map();
  const paths = [];
  const importRegex = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+-column\.service)['"]/g;
  for (const match of text.matchAll(importRegex)) {
    const importPath = match[2];
    if (!importPath.startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(componentPath), `${importPath}.ts`);
    if (!fs.existsSync(resolved)) continue;
    const normalized = normalizePath(resolved);
    paths.push(normalized);
    const symbols = match[1].split(',').map(s => s.trim()).filter(Boolean);
    for (const sym of symbols) {
      const aliasParts = sym.split(/\s+as\s+/i).map(s => s.trim());
      const localName = aliasParts[aliasParts.length - 1];
      if (localName) classToPath.set(localName, normalized);
    }
  }

  for (const match of text.matchAll(/from\s+['"]([^'"]+-column\.service)['"]/g)) {
    if (!match[1].startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(componentPath), `${match[1]}.ts`);
    if (fs.existsSync(resolved)) paths.push(normalizePath(resolved));
  }

  const relatedColumnServices = Array.from(new Set(paths));
  const propToPath = new Map();
  const propRegex = /(?:private|public|protected|readonly)\s+([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_]+)/g;
  for (const match of text.matchAll(propRegex)) {
    const propName = match[1];
    const typeName = match[2];
    if (classToPath.has(typeName)) {
      propToPath.set(propName, classToPath.get(typeName));
    }
  }

  return {
    relatedColumnServices,
    propToPath,
  };
}

function stripHtmlComments(html) {
  return String(html || '').replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\r\n]/g, ' '));
}

function compactFieldEntry(field, relatedColumnServices) {
  const hasRichMeta = Boolean(
    field.ref ||
    field.lovLine ||
    field.configProp ||
    field.lovService !== undefined ||
    field.lovMethod,
  );
  if (!hasRichMeta) {
    if (field.htmlLine) return `${field.name}:${field.line || ''}:${field.htmlLine}`;
    if (field.line) return `${field.name}:${field.line}`;
    return field.name;
  }
  const out = { name: field.name };
  if (field.line) out.line = field.line;
  if (field.htmlLine) out.htmlLine = field.htmlLine;
  if (field.ref) out.ref = field.ref;
  if (field.lovLine) out.lovLine = field.lovLine;
  if (field.configProp) out.configProp = field.configProp;
  if (field.lovService) {
    const idx = relatedColumnServices.indexOf(field.lovService);
    out.lovService = idx >= 0 ? idx : field.lovService;
  }
  if (field.lovMethod) out.lovMethod = field.lovMethod;
  return out;
}

function readComponentFields(rawTs, rawHtml, propToPath, relatedColumnServices) {
  const text = stripComments(rawTs);
  const byName = new Map();

  function ensureField(name) {
    if (!byName.has(name)) {
      byName.set(name, { name });
    }
    return byName.get(name);
  }

  const groupPattern = /(?:formBuilder\.group|fb\.group|new\s+FormGroup)\s*\(\s*\{([\s\S]*?)\}/g;
  for (const groupMatch of text.matchAll(groupPattern)) {
    const body = groupMatch[1];
    const bodyStartIndex = groupMatch.index + groupMatch[0].indexOf('{') + 1;
    for (const propMatch of body.matchAll(/(?:^|[,{\r\n])\s*(['"`]?)([A-Za-z0-9_]+)\1\s*:\s*(?:\[|new\s+FormControl)/g)) {
      const name = propMatch[2];
      const nameOffset = bodyStartIndex + propMatch.index + propMatch[0].indexOf(name);
      const line = text.slice(0, nameOffset).split(/\r?\n/).length;
      const field = ensureField(name);
      if (!field.line) field.line = line;
    }
  }

  const lovPattern = /this\.([A-Za-z0-9_]+)\s*=\s*new\s+GsmLovType\s*\(\s*(['"`])([A-Za-z0-9_$.-]+)\2([\s\S]*?)\);/g;
  for (const match of text.matchAll(lovPattern)) {
    const configProp = match[1];
    const name = match[3];
    const argsBody = match[4] || '';
    const lovLine = text.slice(0, match.index).split(/\r?\n/).length;
    const field = ensureField(name);
    field.lovLine = lovLine;
    field.configProp = configProp;

    const colCallMatch = argsBody.match(/this\.([A-Za-z0-9_]+)\s*\.\s*(get[A-Za-z0-9_]*Columns[A-Za-z0-9_]*)\s*\(/);
    const gridSvcMatch = argsBody.match(/this\.([A-Za-z0-9_]+)\s*\.\s*getGridService\s*\(/);
    const svcProp = colCallMatch?.[1] || gridSvcMatch?.[1] || '';
    if (svcProp && propToPath.has(svcProp)) {
      field.lovService = propToPath.get(svcProp);
    }
    if (colCallMatch?.[2]) {
      field.lovMethod = colCallMatch[2];
    }
  }

  if (rawHtml) {
    const cleanHtml = stripHtmlComments(rawHtml);
    const tagPattern = /<([a-z][a-z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
    for (const match of cleanHtml.matchAll(tagPattern)) {
      const tag = match[1].toLowerCase();
      if (!/^(gig|sales|sl|app|gng|gsm)-/.test(tag)) continue;
      const attrs = match[2] || '';
      const fcMatch = attrs.match(/\bformControlName\s*=\s*['"]([^'"]+)['"]/i) ||
        attrs.match(/\[formControlName\]\s*=\s*['"]'([^']+)'['"]/i);
      const nameAttr = attrs.match(/\bname\s*=\s*['"]([^'"]+)['"]/i)?.[1] || '';
      const refMatch = attrs.match(/#([A-Za-z0-9_]+)/);
      const ref = refMatch ? refMatch[1] : '';
      const isInterestingTag = tag.includes('lov') || tag === 'gig-crud-table';
      const key = fcMatch?.[1] || nameAttr || (isInterestingTag ? (ref || tag) : '');
      if (!key) continue;

      const htmlLine = cleanHtml.slice(0, match.index).split(/\r?\n/).length;
      const field = ensureField(key);
      if (!field.htmlLine) field.htmlLine = htmlLine;
      if (ref && !field.ref) field.ref = ref;
      if (!field.configProp) {
        const cfgMatch = attrs.match(/\b([A-Za-z0-9_]+LovConfig)\b/);
        if (cfgMatch) field.configProp = cfgMatch[1];
      }
    }
  }

  for (const field of byName.values()) {
    if (field.ref && !field.lovLine) {
      const capRef = field.ref.charAt(0).toUpperCase() + field.ref.slice(1);
      const methodRegex = new RegExp(`(?:private|public|protected)\\s+set${capRef}Config\\s*\\(`, 'm');
      const methodMatch = text.match(methodRegex);
      if (methodMatch && typeof methodMatch.index === 'number') {
        field.lovLine = text.slice(0, methodMatch.index).split(/\r?\n/).length;
        continue;
      }
      const refSetupRegex = new RegExp(`this\\.${field.ref}\\s*\\.\\s*(?:fullSelectedRows\\$|lovObject|filterMetaData|setExtraParam)`, 'm');
      const refMatch = text.match(refSetupRegex);
      if (refMatch && typeof refMatch.index === 'number') {
        field.lovLine = text.slice(0, refMatch.index).split(/\r?\n/).length;
      }
    }
  }

  const dmMatch = text.match(/new\s+DataManager\s*\(\s*this\.([A-Za-z0-9_]+)\s*\.\s*(get[A-Za-z0-9_]*Columns[A-Za-z0-9_]*)\s*\(/);
  if (dmMatch && typeof dmMatch.index === 'number') {
    const dmLine = text.slice(0, dmMatch.index).split(/\r?\n/).length;
    const svcProp = dmMatch[1];
    const svcMethod = dmMatch[2];
    const field = ensureField('gig-crud-table');
    if (!field.line) field.line = dmLine;
    if (svcProp && propToPath.has(svcProp)) field.lovService = propToPath.get(svcProp);
    if (svcMethod) field.lovMethod = svcMethod;
  }

  return Array.from(byName.values()).map(field => compactFieldEntry(field, relatedColumnServices));
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

function resolveComponentResource(componentPath, resourcePath) {
  if (!resourcePath || !resourcePath.startsWith('.')) return '';
  return normalizePath(path.resolve(path.dirname(componentPath), resourcePath));
}

function conventionalResource(componentPath, extension) {
  const candidate = componentPath.replace(/\.ts$/i, extension);
  return fs.existsSync(candidate) ? normalizePath(candidate) : '';
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
    const fields = readLiteralColumnFields(raw);
    const entry = {
      className: readClassName(text),
      componentTs,
      entryType: 'column-service',
    };
    if (fields.length) entry.fields = fields;
    return entry;
  }

  const block = extractComponentBlock(text);
  if (!block) return null;

  const selector = readStringProperty(block, 'selector');
  if (!selector) return null;
  const configuredTemplate = readStringProperty(block, 'templateUrl');
  const configuredStyles = readStringArrayProperty(block, 'styleUrls');
  const templateUrl = resolveComponentResource(item.path, configuredTemplate) || conventionalResource(item.path, '.html');
  const defaultTemplateUrl = componentTs.replace(/\.ts$/i, '.html');
  const templateAbsPath = templateUrl ? path.resolve(projectRoot, templateUrl) : '';
  const rawHtml = templateAbsPath && fs.existsSync(templateAbsPath) ? fs.readFileSync(templateAbsPath, 'utf8') : '';
  const { relatedColumnServices, propToPath } = readImportedColumnServicesInfo(text, item.path);
  const styleUrls = configuredStyles.map(stylePath => resolveComponentResource(item.path, stylePath)).filter(Boolean);
  const fields = readComponentFields(raw, rawHtml, propToPath, relatedColumnServices);

  const entry = {
    selector,
    className: readClassName(text),
    componentTs,
    selectorLine: getLineNumber(raw, selector),
  };
  if (templateUrl !== defaultTemplateUrl) {
    entry.templateUrl = templateUrl || '';
  }
  if (styleUrls.length) entry.styleUrls = styleUrls;
  if (relatedColumnServices.length) entry.relatedColumnServices = relatedColumnServices;
  if (fields.length) entry.fields = fields;
  return entry;
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
    const family = entry.selectorFamily || 'created';
    acc[family] = (acc[family] || 0) + 1;
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

  fs.writeFileSync(outFile, JSON.stringify(payload), 'utf8');
  console.log(`Indexed ${entries.length} components (${componentEntries.length} components, ${columnServiceEntries.length} column services).`);
  console.log(`Scanned roots: ${sourceRoots.map(sourceRoot => normalizePath(sourceRoot)).join(', ')}`);
  console.log(`Created/app components: ${counts.created || 0}. Framework components: ${counts.framework || 0}. Unknown: ${counts.unknown || 0}.`);
  console.log(`Wrote ${outFile}`);
}

main();
