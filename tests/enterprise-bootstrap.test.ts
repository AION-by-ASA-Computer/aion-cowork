import { afterEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../src/main/enterprise/auth';

const WIRE = {
  revision: 'sha256:abc',
  generated_at: '2026-10-20T08:00:00Z',
  profiles: [
    {
      slug: 'generic_assistant',
      name: 'Assistente',
      description: 'd',
      instructions: 'be nice',
      max_agent_steps: 20,
      skills: ['core_protocol'],
      mcp_servers: ['khub_rag'],
      native_tool_groups: ['files'],
      updated_at: '2026-10-12T10:00:00Z',
      future_field: 1,
    },
    { slug: '../evil', name: 'bad' },
    'garbage',
  ],
  skills: [
    { name: 'core_protocol', description: 'x', tags: ['core'], version: 3, status: 'verified', content: '# hi' },
    { name: 'no_content', version: 1 },
  ],
  mcp_servers: [
    {
      slug: 'khub_rag',
      display_name: 'Knowledge Hub',
      execution: 'client_remote',
      transport: { type: 'sse', url: 'https://x.test/mcp/sse' },
      auth: 'aion_token',
    },
    { slug: 'memory', display_name: 'Memoria', execution: 'server_only', auth: 'none', transport: { type: 'sse', url: 'https://secret' } },
    { slug: 'bad_url', execution: 'client_remote', transport: { type: 'sse', url: 'file:///etc/passwd' } },
  ],
  policy: { sync_interval_sec: 900 },
};

function res(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

afterEach(() => auth.setFetchImplementation(null));

describe('fetchBootstrap', () => {
  it('maps the wire format, drops malformed items and reads the ETag', async () => {
    const f = vi.fn(async () => res(200, WIRE, { ETag: '"sha256:abc"' }));
    auth.setFetchImplementation(f as never);
    const r = await auth.fetchBootstrap('https://h/api', 'tok', '"old"');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.etag).toBe('"sha256:abc"');
    expect(r.data.profiles).toHaveLength(1);
    expect(r.data.profiles[0]).toMatchObject({
      slug: 'generic_assistant',
      maxAgentSteps: 20,
      mcpServers: ['khub_rag'],
      nativeToolGroups: ['files'],
    });
    expect(r.data.skills.map((s) => s.name)).toEqual(['core_protocol']);
    expect(r.data.mcpServers.map((s) => s.slug)).toEqual(['khub_rag', 'memory']);
    expect(r.data.mcpServers[1].transport).toBeUndefined();
    expect(r.data.mcpServers[0].auth).toBe('aion_token');
    expect(r.data.policy.syncIntervalSec).toBe(900);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://h/api/v1/client/bootstrap');
    expect((init.headers as Record<string, string>)['If-None-Match']).toBe('"old"');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('returns not_modified on 304', async () => {
    auth.setFetchImplementation((async () => new Response(null, { status: 304 })) as never);
    expect(await auth.fetchBootstrap('https://h', 't', '"e"')).toEqual({ status: 'not_modified' });
  });

  it('maps 404 to bootstrap_unsupported and 401 to an http error', async () => {
    auth.setFetchImplementation((async () => res(404, { detail: 'nf' })) as never);
    await expect(auth.fetchBootstrap('https://h', 't')).rejects.toMatchObject({
      status: 404,
      error: { code: 'bootstrap_unsupported' },
    });
    auth.setFetchImplementation((async () => res(401, { detail: 'no' })) as never);
    await expect(auth.fetchBootstrap('https://h', 't')).rejects.toMatchObject({ status: 401 });
  });

  it('is defensive about odd payloads', () => {
    expect(() => auth.parseBootstrap(null)).toThrow();
    const d = auth.parseBootstrap({ profiles: 'x', skills: {}, mcp_servers: null, policy: { sync_interval_sec: -1 } });
    expect(d.profiles).toEqual([]);
    expect(d.policy.syncIntervalSec).toBe(auth.DEFAULT_SYNC_INTERVAL_SEC);
  });
});
