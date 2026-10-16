/**
 * Seams for adopted T3 Code files (docs/specs/t3/README.md, "Adapting T3 components").
 *
 * An adopted T3 file keeps its imports as upstream wrote them. When one names a module web2 does not
 * have (Effect atoms, `@t3tools/client-runtime`, Electron window helpers, T3 router hooks), add a
 * small stand-in here and point the import at it with an alias in `t3-shims.ts` (Vite, Vitest) and
 * `tsconfig.json` `paths`, so the adopted body stays as close to upstream as possible.
 *
 * Each shim says which upstream module it replaces. Keep them tiny: a shim that grows logic is a
 * sign the component should be adapted, not shimmed.
 */
export {};
