import { afterEach, describe, expect, it } from 'vitest';
import {
  createManagedProfileResolver,
  setManagedProfileResolver,
} from '../src/main/enterprise/profile-resolver';
import {
  getManagedProfileResolver as getEngineResolver,
  getProfileForSlug,
  isKnownProfileSlug,
} from '../src/main/enterprise/engine-bridge';

describe('enterprise resolver wiring', () => {
  afterEach(() => setManagedProfileResolver(null));

  it('exposes the registered resolver to the engine bridge', () => {
    const resolver = createManagedProfileResolver({
      getProfiles: () => [
        {
          slug: 'hr',
          name: 'HR',
          description: '',
          instructions: 'Be helpful',
          skills: [],
          mcpServers: [],
          nativeToolGroups: [],
        },
      ],
      getMcpServers: () => [],
      getSkillPaths: () => [],
    });
    expect(getEngineResolver()).toBeNull();
    setManagedProfileResolver(resolver);
    expect(getEngineResolver()).toBe(resolver);
    expect(isKnownProfileSlug('hr')).toBe(true);
    expect(getProfileForSlug('hr')?.instructions).toBe('Be helpful');
    setManagedProfileResolver(null);
    expect(isKnownProfileSlug('hr')).toBe(false);
  });
});
