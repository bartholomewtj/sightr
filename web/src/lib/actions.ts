// Dialog action recipes: detect the dialog on a fresh screen, then send its keys; free-text replies
// use the same guard. One module per job (spec 12); this barrel keeps every existing import site.

export { menusEqual, menusSameIdentity } from "./harness/menu-model";
export { wizardsEqual } from "./harness/wizard-model";
export { promptsEqual, promptsSameIdentity, sameKeys } from "./harness/prompt-model";
export { previewsEqual } from "./harness/preview-model";
export { multiSelectEquals, multiSelectIdentity } from "./harness/multi-select-model";
export * from "./menu-action";
export * from "./wizard-action";
export * from "./prompt-action";
export * from "./preview-action";
export * from "./multi-select-action";
export * from "./reply-action";
