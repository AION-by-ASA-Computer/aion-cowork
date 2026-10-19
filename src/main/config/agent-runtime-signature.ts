import type { AppConfig } from './config-store';

/**
 * Hash of the config fields that require reloading the in-process agent runner.
 * Changing only contextWindow or maxTokens must change this signature so an
 * already-running session manager picks up numeric-only overrides.
 */
export function buildAgentRuntimeSignature(config: AppConfig): string {
  // Managed (enterprise) sets rotate their token often; the runner re-applies the
  // runtime API key on every run, so a token refresh must not reload the runner.
  const activeSet = config.configSets?.find((set) => set.id === config.activeConfigSetId);
  const managed = activeSet?.managed === 'aion';
  return JSON.stringify({
    provider: config.provider,
    apiKey: managed ? undefined : config.apiKey,
    managed: managed || undefined,
    baseUrl: config.baseUrl,
    customProtocol: config.customProtocol,
    model: config.model,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    enableThinking: config.enableThinking,
    memoryEnabled: config.memoryEnabled,
    memoryRuntime: config.memoryRuntime,
  });
}
