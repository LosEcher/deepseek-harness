/**
 * Platform-singleton module-table. Fetch bundles resolve their externals
 * against this table through the loader's require. Live keys come from the
 * platform constant module ({@link ./platform.ts}, the single source of
 * truth with the tsdown client externals); values stay shell-static imports
 * so every bundle sees the same instance. Deleted-specifier aliases are
 * extra keys on the same store instance and are not platform words.
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as Cordis from '@deepseek-ai/cordis'
import * as ClientStore from '@deepseek-ai/dsh-client-store'
import * as UiSlots from '@deepseek-ai/dsh-client-ui-slots'
import * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import * as UiDockkit from '@deepseek-ai/dsh-client-ui-dockkit'
import type { PlatformModule } from './platform.ts'

/**
 * Build the static table handed to the module loader at boot.
 * @returns module specifier → exported entity (one entry per platform word,
 *   plus deleted-specifier aliases that out-of-tree bundles still require).
 */
export function getStaticModules(): Record<string, unknown> {
  // The satisfies pin is the projection contract: a word added to
  // PLATFORM_MODULES without a static import here (or vice versa) fails to
  // compile instead of drifting into a runtime require miss.
  const platform = {
    'react': React,
    'react/jsx-runtime': ReactJsxRuntime,
    'react-dom': ReactDom,
    'react-dom/client': ReactDomClient,
    '@deepseek-ai/cordis': Cordis,
    '@deepseek-ai/dsh-client-store': ClientStore,
    '@deepseek-ai/dsh-client-ui-slots': UiSlots,
    '@deepseek-ai/dsh-client-ui-primitives': UiPrimitives,
    '@deepseek-ai/dsh-client-ui-dockkit': UiDockkit,
  } satisfies Record<PlatformModule, unknown>
  // Out-of-tree client bundles still require the 0.1.0 runtime specifier.
  // Keep the aliases off PLATFORM_MODULES so first-party externals stay on
  // the live store word.
  return {
    ...platform,
    '@deepseek-ai/dsh-client-runtime': ClientStore,
    '@deepseek-ai/dsh-client-runtime/client': ClientStore,
  }
}
