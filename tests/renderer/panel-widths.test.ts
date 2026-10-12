import { describe, expect, it } from 'vitest'
import { PANE_LIMITS, clampPane, parsePaneWidths } from '../../src/renderer/src/lib/panel-widths'
import { clampGraphWidth } from '../../src/renderer/src/lib/graph-columns'

describe('pane widths', () => {
  it('falls back to defaults for missing or corrupt storage', () => {
    const defaults = { sidebar: PANE_LIMITS.sidebar.def, details: PANE_LIMITS.details.def }
    expect(parsePaneWidths(null)).toEqual(defaults)
    expect(parsePaneWidths('not json')).toEqual(defaults)
    expect(parsePaneWidths('"str"')).toEqual(defaults)
    expect(parsePaneWidths('{"sidebar":"wide","details":null}')).toEqual(defaults)
  })

  it('keeps stored widths within limits', () => {
    expect(parsePaneWidths('{"sidebar":300.4,"details":500}')).toEqual({ sidebar: 300, details: 500 })
    expect(clampPane('sidebar', 10)).toBe(PANE_LIMITS.sidebar.min)
    expect(clampPane('details', 99999)).toBe(PANE_LIMITS.details.max)
    expect(clampPane('details', Number.NaN)).toBe(PANE_LIMITS.details.def)
  })

  it('clamps the graph column', () => {
    expect(clampGraphWidth(5)).toBe(32)
    expect(clampGraphWidth(120.6)).toBe(121)
    expect(clampGraphWidth(5000)).toBe(800)
  })
})
