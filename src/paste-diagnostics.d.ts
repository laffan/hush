/**
 * Types for `paste-diagnostics.js`. Plain JS like its siblings — shared
 * with the untypechecked editor half — but the notebook is compiled, and
 * `tsconfig.json` only covers `src/notebook`, so the surface is declared
 * here rather than duplicating the module.
 */
export declare function describeClipboard(dt: DataTransfer | null | undefined): Record<string, unknown>;
export declare function describeActiveElement(): string;
