/*
 * Hexabot — Fair Core License (FCL-1.0-ALv2)
 * Copyright (c) 2026 Hexastack.
 * Full terms: see LICENSE.md.
 */

export type TanstackModules = {
  ai: typeof import('@tanstack/ai');
  sandbox: typeof import('@tanstack/ai-sandbox');
  docker: typeof import('@tanstack/ai-sandbox-docker');
  codex: typeof import('@tanstack/ai-codex');
  claudeCode: typeof import('@tanstack/ai-claude-code');
  grokBuild: typeof import('@tanstack/ai-grok-build');
  opencode: typeof import('@tanstack/ai-opencode');
};

export type ModuleLoader = () => Promise<TanstackModules>;

const esmImport = new Function('specifier', 'return import(specifier)') as <T>(
  specifier: string,
) => Promise<T>;
const loadTanstackModules: ModuleLoader = async () => {
  const [ai, sandbox, docker, codex, claudeCode, grokBuild, opencode] =
    await Promise.all([
      esmImport<typeof import('@tanstack/ai')>('@tanstack/ai'),
      esmImport<typeof import('@tanstack/ai-sandbox')>('@tanstack/ai-sandbox'),
      esmImport<typeof import('@tanstack/ai-sandbox-docker')>(
        '@tanstack/ai-sandbox-docker',
      ),
      esmImport<typeof import('@tanstack/ai-codex')>('@tanstack/ai-codex'),
      esmImport<typeof import('@tanstack/ai-claude-code')>(
        '@tanstack/ai-claude-code',
      ),
      esmImport<typeof import('@tanstack/ai-grok-build')>(
        '@tanstack/ai-grok-build',
      ),
      esmImport<typeof import('@tanstack/ai-opencode')>(
        '@tanstack/ai-opencode',
      ),
    ]);

  return {
    ai,
    sandbox,
    docker,
    codex,
    claudeCode,
    grokBuild,
    opencode,
  };
};

let tanstackModuleLoader: ModuleLoader = loadTanstackModules;

export function loadTanstackModulesForRun() {
  return tanstackModuleLoader();
}

export function setTanstackModuleLoaderForTesting(loader: ModuleLoader) {
  tanstackModuleLoader = loader;
}

export function resetTanstackModuleLoaderForTesting() {
  tanstackModuleLoader = loadTanstackModules;
}
