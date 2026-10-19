#!/usr/bin/env node
// Verifica che ogni file sorgente upstream modificato dal fork sia dichiarato in FORK_TOUCHPOINTS.md.
// Nessuna dipendenza esterna. Uso: npm run check:fork (oppure: node scripts/check-fork-touchpoints.mjs)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const THRESHOLD = 15;
const UPSTREAM_REF = 'upstream/main';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const touchpointsPath = join(repoRoot, 'FORK_TOUCHPOINTS.md');

// File e cartelle dell'overlay Enterprise: sono codice nostro, non vanno dichiarati.
const OVERLAY_PREFIXES = ['src/main/enterprise/', 'src/renderer/theme/'];
const OVERLAY_FILES = new Set([
  'src/renderer/components/settings/SettingsAccount.tsx',
  'src/renderer/components/EnterpriseOnboarding.tsx',
  'src/shared/enterprise-types.ts',
  'src/shared/enterprise-sync-types.ts',
  'src/renderer/hooks/useEnterpriseStatus.ts',
  'src/renderer/hooks/useManagedProfiles.ts',
  'src/renderer/components/ProfileSelector.tsx',
  'src/renderer/components/ProfileBadge.tsx',
  'src/renderer/utils/enterprise-api.ts',
  'src/renderer/utils/enterprise-helpers.ts',
  'src/renderer/utils/enterprise-profiles.ts',
]);

// Asset binari, test, documentazione: esclusi dal controllo.
const IGNORED_PREFIXES = ['resources/', 'public/', 'src/renderer/assets/', 'docs/', 'tests/'];
const IGNORED_EXTENSIONS = ['.png', '.icns', '.ico'];
const IGNORED_FILES = new Set(['FORK_TOUCHPOINTS.md']);

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function upstreamExists() {
  try {
    git(['rev-parse', '--verify', '--quiet', UPSTREAM_REF]);
    return true;
  } catch {
    return false;
  }
}

function isIgnored(file) {
  if (IGNORED_FILES.has(file)) return true;
  if (IGNORED_PREFIXES.some((p) => file.startsWith(p))) return true;
  if (IGNORED_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext))) return true;
  return false;
}

function isOverlay(file) {
  return OVERLAY_FILES.has(file) || OVERLAY_PREFIXES.some((p) => file.startsWith(p));
}

// Estrae tutti i token tra backtick dal documento: un file e' dichiarato se compare cosi'.
function parseDeclaredPaths(markdown) {
  const declared = new Set();
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    declared.add(match[1].trim());
  }
  return declared;
}

function main() {
  if (!upstreamExists()) {
    console.log(`NOTICE: il ref "${UPSTREAM_REF}" non esiste. Esegui "git remote add upstream https://github.com/OpenCoworkAI/open-cowork.git" e poi "git fetch upstream". Controllo saltato.`);
    process.exit(0);
  }

  if (!existsSync(touchpointsPath)) {
    console.error(`ERRORE: file non trovato: ${touchpointsPath}`);
    process.exit(1);
  }

  const base = git(['merge-base', 'HEAD', UPSTREAM_REF]);
  const changed = git(['diff', '--name-only', base, 'HEAD'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const sourceFiles = changed.filter((file) => !isIgnored(file) && !isOverlay(file));
  const declared = parseDeclaredPaths(readFileSync(touchpointsPath, 'utf8'));
  const undeclared = sourceFiles.filter((file) => !declared.has(file));

  console.log(`Merge-base con ${UPSTREAM_REF}: ${base.slice(0, 12)}`);
  console.log(`File upstream modificati (sorgenti, esclusi asset/test/overlay): ${sourceFiles.length}`);

  if (sourceFiles.length > THRESHOLD) {
    console.warn(
      `WARNING: ${sourceFiles.length} file sorgente upstream modificati, sopra la soglia di ${THRESHOLD}. Rivedere FORK_TOUCHPOINTS.md (vedi "Regole").`,
    );
  }

  if (undeclared.length > 0) {
    console.error('\nERRORE: file upstream modificati non dichiarati in FORK_TOUCHPOINTS.md:');
    for (const file of undeclared) console.error(`  - ${file}`);
    console.error('\nAggiungi ogni file alla tabella "File upstream modificato | Motivo" con il motivo della modifica.');
    process.exit(1);
  }

  console.log('OK: tutti i file upstream modificati sono dichiarati.');
  process.exit(0);
}

main();
