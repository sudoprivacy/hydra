const fs = require('fs');
const path = require('path');

function normalizeWorkspacePatterns(workspaces) {
  const patterns = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error('root package.json has no npm workspace patterns');
  }
  return patterns.map((pattern) => {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      throw new Error('root package.json contains an invalid npm workspace pattern');
    }
    const negated = pattern.startsWith('!');
    const normalized = pattern
      .slice(negated ? 1 : 0)
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/package\.json$/, '')
      .replace(/\/$/, '');
    return { negated, regex: workspacePatternToRegExp(normalized) };
  });
}

function workspacePatternToRegExp(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.-]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function discoverWorkspaceManifestPaths(repoRoot) {
  const rootManifestPath = path.join(repoRoot, 'package.json');
  const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, 'utf8'));
  const patterns = normalizeWorkspacePatterns(rootManifest.workspaces);
  const manifests = [];

  function visit(relativeDirectory) {
    const absoluteDirectory = path.join(repoRoot, relativeDirectory);
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      const childDirectory = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const included = patterns.some(({ negated, regex }) => !negated && regex.test(childDirectory));
      const excluded = patterns.some(({ negated, regex }) => negated && regex.test(childDirectory));
      if (included && !excluded && fs.existsSync(path.join(repoRoot, childDirectory, 'package.json'))) {
        manifests.push(`${childDirectory}/package.json`);
      }
      visit(childDirectory);
    }
  }

  visit('');
  return manifests.sort((left, right) => left.localeCompare(right));
}

module.exports = { discoverWorkspaceManifestPaths };
