/**
 * A spot in a pane's header that its panel can fill (with createPortal) —
 * e.g. a single-widget pane puts its controls there instead of drawing a
 * second header.
 */
export function paneSlotId(paneId: string) {
  return `pane-slot-${paneId}`;
}
