import { describe, expect, it } from 'vitest'
import { nextZoom } from '../../src/main/zoom'

describe('nextZoom', () => {
  it('steps through fixed levels and clamps at the ends', () => {
    expect(nextZoom(1, 'in')).toBe(1.1)
    expect(nextZoom(1, 'out')).toBe(0.9)
    expect(nextZoom(1.3, 'in')).toBe(1.5)
    expect(nextZoom(2, 'in')).toBe(2)
    expect(nextZoom(0.67, 'out')).toBe(0.67)
    expect(nextZoom(1.75, 'reset')).toBe(1)
  })
})
