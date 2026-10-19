import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManagedSkillsWriter, sanitizeName } from '../src/main/enterprise/managed-skills';
import type { ManagedProfile, ManagedSkill } from '../src/shared/enterprise-sync-types';

let tmp: string;
let w: ManagedSkillsWriter;

const skill = (name: string, content = `# ${name}`, version = 1): ManagedSkill => ({
  name,
  description: '',
  tags: [],
  version,
  content,
});
const profile = (slug: string, skills: string[]): ManagedProfile => ({
  slug,
  name: slug,
  description: '',
  instructions: '',
  skills,
  mcpServers: [],
  nativeToolGroups: [],
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aion-skills-'));
  w = new ManagedSkillsWriter(path.join(tmp, 'skills'), path.join(tmp, 'sets'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('managed skills', () => {
  it('sanitizes names and never escapes the root', () => {
    expect(sanitizeName('..')).toBeNull();
    expect(sanitizeName('../../etc')).toBe('etc');
    expect(w.skillDirForName('../../etc/passwd')?.startsWith(w.root + path.sep)).toBe(true);
    expect(w.skillDirForName('..')).toBeNull();
    expect(w.skillDirForName('')).toBeNull();
    expect(path.basename(w.skillDirForName('My Skill/X')!)).toMatch(/^[a-z0-9._-]+$/);
    w.apply([skill('../../escape')], []);
    expect(fs.existsSync(path.join(tmp, 'escape'))).toBe(false);
  });

  it('writes SKILL.md, rewrites only on change, deletes removed skills', () => {
    w.apply([skill('a'), skill('b')], []);
    const fa = path.join(w.root, 'a', 'SKILL.md');
    expect(fs.readFileSync(fa, 'utf8')).toBe('# a');
    fs.utimesSync(fa, new Date(1000), new Date(1000));
    w.apply([skill('a'), skill('b')], []);
    expect(fs.statSync(fa).mtimeMs).toBe(1000); // untouched: not rewritten
    w.apply([skill('a', '# a v2', 2)], []);
    expect(fs.readFileSync(fa, 'utf8')).toBe('# a v2');
    expect(fs.existsSync(path.join(w.root, 'b'))).toBe(false);
  });

  it('builds per-profile skill sets as copies', () => {
    w.apply([skill('a'), skill('b')], [profile('p1', ['a', 'missing']), profile('p2', ['b'])]);
    expect(w.getSkillPaths('p1')).toEqual([path.join(w.setsRoot, 'p1')]);
    expect(fs.readdirSync(path.join(w.setsRoot, 'p1'))).toEqual(['a']);
    expect(fs.readFileSync(path.join(w.setsRoot, 'p2', 'b', 'SKILL.md'), 'utf8')).toBe('# b');
    expect(w.getSkillPaths('nope')).toEqual([]);
    w.apply([skill('a')], [profile('p1', [])]);
    expect(w.getSkillPaths('p1')).toEqual([]);
    expect(fs.existsSync(path.join(w.setsRoot, 'p2'))).toBe(false);
  });

  it('clear removes everything', () => {
    w.apply([skill('a')], [profile('p', ['a'])]);
    w.clear();
    expect(fs.existsSync(w.root)).toBe(false);
    expect(fs.existsSync(w.setsRoot)).toBe(false);
  });
});
