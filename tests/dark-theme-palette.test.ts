import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const stylesPath = path.resolve(process.cwd(), 'src/renderer/styles/globals.css');

describe('dark theme palette', () => {
  it('uses the neutral AION palette for the default theme', () => {
    const source = fs.readFileSync(stylesPath, 'utf8');
    expect(source).toContain('--color-background: #161618;');
    expect(source).toContain('--color-surface: #1f1f23;');
    expect(source).toContain('--color-text-primary: #fafafa;');
  });

  it('keeps the accent on the AION brand red', () => {
    const source = fs.readFileSync(stylesPath, 'utf8');
    expect(source).toContain('--color-accent: #e02424;');
    expect(source).toContain('--color-accent-hover: #c81e1e;');
  });
});
