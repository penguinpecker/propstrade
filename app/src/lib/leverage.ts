/**
 * The order ticket's leverage slider. The range input runs 0..SLIDER_STEPS through evenly spaced anchors (the leverage
 * presets below the side's maximum, then that maximum), so each preset label sits under the thumb at its own value;
 * between two neighbouring anchors the leverage is linear in the position.
 */
export const SLIDER_STEPS = 1000;

/** The whole leverage at a slider position, within [1, the last anchor]; with one anchor only, that anchor. */
export function positionToLeverage(position: number, anchors: number[]): number {
  const max = anchors[anchors.length - 1]!;
  const segments = anchors.length - 1;
  if (segments < 1) return max;
  const at = Math.min(Math.max(position, 0), SLIDER_STEPS) / SLIDER_STEPS * segments;
  const i = Math.min(Math.floor(at), segments - 1);
  const value = anchors[i]! + (at - i) * (anchors[i + 1]! - anchors[i]!);
  return Math.min(max, Math.max(1, Math.round(value)));
}

/** The slider position of a leverage: the inverse of positionToLeverage, so the thumb sits on the chosen value. */
export function leverageToPosition(leverage: number, anchors: number[]): number {
  const segments = anchors.length - 1;
  if (segments < 1) return SLIDER_STEPS; // one anchor: the thumb stays at the end
  if (leverage <= anchors[0]!) return 0;
  for (let i = 0; i < segments; i += 1)
    if (leverage <= anchors[i + 1]!) return (i + (leverage - anchors[i]!) / (anchors[i + 1]! - anchors[i]!)) * SLIDER_STEPS / segments;
  return SLIDER_STEPS;
}

/** Page Up / Page Down: the next anchor above a leverage, or the last one below it (the values the labels mark). */
export function pageLeverage(leverage: number, anchors: number[], up: boolean): number {
  return up ? anchors.find(a => a > leverage) ?? anchors[anchors.length - 1]! : [...anchors].reverse().find(a => a < leverage) ?? anchors[0]!;
}
