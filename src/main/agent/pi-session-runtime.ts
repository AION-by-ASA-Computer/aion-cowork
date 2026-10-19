import { createHash } from 'node:crypto';
import type { SubagentConfig } from '../../shared/subagent-config';

export interface PiSessionRuntimeSignatureInput {
  configProvider?: string;
  customProtocol?: string;
  modelProvider?: string;
  modelApi?: string;
  modelBaseUrl?: string;
  effectiveCwd?: string;
  apiKey?: string;
  /** Managed (rotating-token) sets: key is applied per run, so exclude it from the signature. */
  excludeApiKey?: boolean;
  subagent?: SubagentConfig;
  /** Enterprise profile fingerprint (slug + hash of instructions/MCP/skills); omitted for standalone sessions. */
  profile?: string;
}

function normalizeText(value: string | undefined): string {
  return value?.trim() || '';
}

function fingerprintSecret(value: string | undefined): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }
  return createHash('sha256').update(normalized).digest('hex');
}

export function buildPiSessionRuntimeSignature(input: PiSessionRuntimeSignatureInput): string {
  return JSON.stringify({
    configProvider: normalizeText(input.configProvider),
    customProtocol: normalizeText(input.customProtocol),
    modelProvider: normalizeText(input.modelProvider),
    modelApi: normalizeText(input.modelApi),
    modelBaseUrl: normalizeText(input.modelBaseUrl).replace(/\/+$/, ''),
    effectiveCwd: normalizeText(input.effectiveCwd),
    apiKeyFingerprint: input.excludeApiKey ? '' : fingerprintSecret(input.apiKey),
    subagent: input.subagent,
    profile: input.profile,
  });
}
