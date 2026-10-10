import { AzureDevOpsAdapter } from './azure'
import { BitbucketAdapter } from './bitbucket'
import { GitHubAdapter } from './github'
import { GitLabAdapter } from './gitlab'
import { ProviderError, type AdapterOptions, type ProviderAdapter, type ProviderKind } from './types'

export * from './types'
export { parseRemoteUrl, defaultApiBaseUrl, type SelfHostedProvider } from './detect'
export { providerFetch, redact, assertAllowedBaseUrl, type AuthScheme, type ProviderFetchOptions, type ProviderResponse } from './client'
export { GitHubAdapter } from './github'
export { GitLabAdapter } from './gitlab'
export { BitbucketAdapter } from './bitbucket'
export { AzureDevOpsAdapter, AZURE_VOTE } from './azure'
export {
  startDeviceFlow,
  pollDeviceFlow,
  type DeviceFlowStart,
  type DeviceFlowToken,
  type StartDeviceFlowOptions,
  type PollDeviceFlowOptions,
} from './oauth'

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  azure: 'Azure DevOps',
}

/** Construct the adapter for a provider. Must run in the main process (holds the token). */
export function createAdapter(kind: ProviderKind, opts: AdapterOptions): ProviderAdapter {
  if (typeof opts?.token !== 'string' || !opts.token.trim()) {
    throw new ProviderError('INVALID_ARGUMENT', 'No access token configured.')
  }
  switch (kind) {
    case 'github':
      return new GitHubAdapter(opts)
    case 'gitlab':
      return new GitLabAdapter(opts)
    case 'bitbucket':
      return new BitbucketAdapter(opts)
    case 'azure':
      return new AzureDevOpsAdapter(opts)
    default:
      throw new ProviderError('INVALID_ARGUMENT', `Unknown provider: ${String(kind)}`)
  }
}
