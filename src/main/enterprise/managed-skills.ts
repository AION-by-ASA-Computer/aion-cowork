/**
 * Writes server-managed skills to disk so the agent engine can load them like any other skill.
 *
 *   <root>/<name>/SKILL.md                    all synced skills (aion-managed-skills)
 *   <setsRoot>/<profile slug>/<name>/SKILL.md per-profile skill sets: pi consumes a directory that
 *                                             contains skill sub-folders, so each profile gets its own
 *                                             directory of copies (copies, not symlinks: robust on Windows).
 *
 * Names come from the server and are untrusted: they are sanitized to [a-z0-9._-] and every
 * resolved path is verified to stay inside its root.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ManagedProfile, ManagedSkill } from '../../shared/enterprise-sync-types';
import type { ManagedSkillMeta } from './managed-store';

export function sanitizeName(raw: string): string | null {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-+$/, '')
    .slice(0, 100);
  if (!s || s === '.' || s === '..') return null;
  return s;
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function readHash(file: string): string | null {
  try {
    return hashContent(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function removeUnknownChildren(dir: string, keep: Set<string>): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (keep.has(e)) continue;
    fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  }
}

export class ManagedSkillsWriter {
  constructor(
    readonly root: string,
    readonly setsRoot: string
  ) {}

  /** Directory for a skill, or null when the name cannot be mapped safely. */
  skillDirForName(name: string): string | null {
    const safe = sanitizeName(name);
    if (!safe) return null;
    const dir = path.resolve(this.root, safe);
    return isInside(path.resolve(this.root), dir) ? dir : null;
  }

  private profileDir(slug: string): string | null {
    const safe = sanitizeName(slug);
    if (!safe) return null;
    const dir = path.resolve(this.setsRoot, safe);
    return isInside(path.resolve(this.setsRoot), dir) ? dir : null;
  }

  /**
   * Makes the disk match the given skills/profiles. Files are rewritten only when the content
   * hash differs; directories of skills that disappeared are deleted.
   */
  apply(skills: ManagedSkill[], profiles: ManagedProfile[]): ManagedSkillMeta[] {
    fs.mkdirSync(this.root, { recursive: true });
    const metas: ManagedSkillMeta[] = [];
    const byDir = new Map<string, { skill: ManagedSkill; hash: string }>();
    const nameToDir = new Map<string, string>();

    for (const skill of skills) {
      const dir = this.skillDirForName(skill.name);
      if (!dir) continue;
      const hash = hashContent(skill.content);
      const dirName = path.basename(dir);
      const file = path.join(dir, 'SKILL.md');
      if (readHash(file) !== hash) writeAtomic(file, skill.content);
      byDir.set(dirName, { skill, hash });
      nameToDir.set(skill.name, dirName);
      metas.push({
        name: skill.name,
        description: skill.description,
        tags: skill.tags,
        version: skill.version,
        contentHash: hash,
      });
    }
    removeUnknownChildren(this.root, new Set(byDir.keys()));

    // Per-profile sets
    fs.mkdirSync(this.setsRoot, { recursive: true });
    const keepProfiles = new Set<string>();
    for (const profile of profiles) {
      const pdir = this.profileDir(profile.slug);
      if (!pdir) continue;
      const wanted = new Map<string, { skill: ManagedSkill; hash: string }>();
      for (const skillName of profile.skills) {
        const dirName = nameToDir.get(skillName);
        const entry = dirName ? byDir.get(dirName) : undefined;
        if (dirName && entry) wanted.set(dirName, entry);
      }
      keepProfiles.add(path.basename(pdir));
      fs.mkdirSync(pdir, { recursive: true });
      for (const [dirName, { skill, hash }] of wanted) {
        const file = path.join(pdir, dirName, 'SKILL.md');
        if (readHash(file) !== hash) writeAtomic(file, skill.content);
      }
      removeUnknownChildren(pdir, new Set(wanted.keys()));
    }
    removeUnknownChildren(this.setsRoot, keepProfiles);
    return metas;
  }

  /** Skill directories (roots that contain skill sub-folders) to add for a profile. */
  getSkillPaths(slug: string): string[] {
    const pdir = this.profileDir(slug);
    if (!pdir) return [];
    try {
      const has = fs
        .readdirSync(pdir, { withFileTypes: true })
        .some((e) => e.isDirectory() && fs.existsSync(path.join(pdir, e.name, 'SKILL.md')));
      return has ? [pdir] : [];
    } catch {
      return [];
    }
  }

  /** Removes everything written to disk. */
  clear(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
    fs.rmSync(this.setsRoot, { recursive: true, force: true });
  }
}
