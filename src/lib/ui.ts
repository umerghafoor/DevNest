/**
 * Shared class strings for compact panel toolbars (Logs, systemd, …) so
 * panels look the same. Plain inputs here deliberately avoid the global
 * `.input` class: it's unlayered CSS, so its large padding / font size would
 * override these utilities.
 */

/** Slim text input for toolbars (filter boxes, inline commands). */
export const SMALL_INPUT =
  "h-6 rounded-md border border-transparent bg-(--color-surface) px-2 text-xs text-(--color-fg) outline-none placeholder:text-(--color-fg-muted) focus:border-(--color-accent)";

/** Container that groups related toolbar buttons into one pill. */
export const BTN_GROUP =
  "flex items-center rounded-md bg-(--color-surface) p-0.5";

/** Button inside a BTN_GROUP. */
export const TOOL_BTN =
  "inline-flex h-6 items-center justify-center gap-1 rounded px-2 hover:bg-(--color-surface-2) disabled:opacity-40";

/** Segmented-control option inside a BTN_GROUP; `active` highlights it. */
export function segBtn(active: boolean): string {
  return `h-6 rounded px-2 transition-colors ${
    active
      ? "bg-(--color-accent) text-(--color-accent-fg)"
      : "text-(--color-fg-muted) hover:text-(--color-fg)"
  }`;
}
