// SPDX-License-Identifier: Apache-2.0

import type { LLMProvider } from '../types.js';
import { AnthropicProvider } from './anthropic.js';
import {
  getCustomProviderPreset,
  getDefaultModel,
  getProviderPreset,
  resolveApiKey,
  resolveBaseUrl,
} from './catalog.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

/**
 * Build an LLMProvider from a catalog preset — or from a `custom-*` provider
 * configured via the Providers settings page (synthesized BYO preset).
 * Reads the key via resolveApiKey (env var, then providers.local.json); never logs it.
 *
 * BYO presets (e.g. omnirush, custom-*) ship with an empty baseUrl. If the user
 * has not configured an endpoint yet, this throws a clear configuration error
 * instead of attempting a request to an empty URL.
 */
export function createProvider(providerId: string): LLMProvider {
  const preset = getProviderPreset(providerId) ?? getCustomProviderPreset(providerId);
  if (!preset) {
    throw new Error(
      `Unknown provider "${providerId}". Provider presets live in src/providers/catalog.json — add one there to support a new endpoint, or use a "custom-*" id via the Providers settings page.`,
    );
  }

  const baseUrl = resolveBaseUrl(providerId);
  if (!baseUrl) {
    const label = preset.byo ? `${preset.name} is a bring-your-own provider: no endpoint is pre-configured. ` : '';
    throw new Error(
      `${label}Open the Providers settings page and enter an API endpoint (base URL) plus your own ${preset.envKey}, then try again. ` +
        `Never use a shared or pooled key.`,
    );
  }

  const apiKey = resolveApiKey(providerId);
  if (!apiKey) {
    if (preset.bridge) {
      const label = preset.bridge === 'claude' ? 'Claude Code' : 'Codex CLI';
      throw new Error(
        `${preset.name} is not connected: click Connect in the Providers settings page to use your ${label} login. ` +
          `The token is read from your CLI's own credential file at request time and never stored.`,
      );
    }
    throw new Error(
      `Missing ${preset.envKey}: set the ${preset.envKey} environment variable or add it via the Providers settings page (stored in providers.local.json, 0600).`,
    );
  }

  if (preset.api === 'anthropic') {
    // Subscription bridges authenticate with the user's OAuth token, which the
    // Messages API expects as a Bearer credential (Claude Code wire format),
    // not x-api-key.
    return new AnthropicProvider({
      baseUrl,
      apiKey,
      authStyle: preset.bridge === 'claude' ? 'bearer' : 'api-key',
      // Keep rate-limit snapshots per catalog id (claude-subscription ≠ anthropic).
      providerId: preset.id,
    });
  }
  return new OpenAICompatibleProvider({
    providerId: preset.id,
    baseUrl,
    apiKey,
    extraHeaders: preset.extraHeaders,
    defaultModel: getDefaultModel(preset.id),
  });
}
