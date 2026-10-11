/** Zoom levels the View menu, Ctrl/Cmd +/- and the status bar step through. */
export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

export function nextZoom(current: number, action: 'in' | 'out' | 'reset'): number {
  if (action === 'reset') return 1
  if (action === 'in') return ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_STEPS[0]!
}
