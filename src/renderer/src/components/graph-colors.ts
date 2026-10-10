const LANE_COUNT = 11

/** Lane colors are CSS variables so they adapt to the light and dark themes (see styles.css). */
export function laneColor(index: number): string {
  return `var(--lane-${index % LANE_COUNT})`
}
