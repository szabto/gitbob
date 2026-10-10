export const LANE_COLORS = [
  '#3ee0f5',
  '#b46cff',
  '#62d39a',
  '#f2b84b',
  '#e86fd2',
  '#ff7b72',
  '#9d8cff',
  '#46c7d6',
  '#d2a26b',
  '#a6d94f',
  '#ff9e5e',
]

export function laneColor(index: number): string {
  return LANE_COLORS[index % LANE_COLORS.length]!
}
