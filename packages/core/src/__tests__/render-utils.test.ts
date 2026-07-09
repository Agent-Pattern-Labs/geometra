import { describe, expect, it } from 'vitest'
import { normalizeBorderRadius, parseColorRGBA } from '../render-utils.js'

describe('parseColorRGBA', () => {
  it('parses 6-digit hex', () => {
    expect(parseColorRGBA('#3b82f6')).toEqual([0x3b / 255, 0x82 / 255, 0xf6 / 255, 1])
  })

  it('parses 3-digit hex by doubling each nibble', () => {
    expect(parseColorRGBA('#fff')).toEqual([1, 1, 1, 1])
    expect(parseColorRGBA('#000')).toEqual([0, 0, 0, 1])
    expect(parseColorRGBA('#f0a')).toEqual([1, 0, 170 / 255, 1])
  })

  it('parses rgb() with implicit opaque alpha', () => {
    expect(parseColorRGBA('rgb(59, 130, 246)')).toEqual([59 / 255, 130 / 255, 246 / 255, 1])
  })

  it('parses rgba() with explicit decimal alpha', () => {
    expect(parseColorRGBA('rgba(59, 130, 246, 0.4)')).toEqual([59 / 255, 130 / 255, 246 / 255, 0.4])
  })

  it('parses rgba() with alpha = 0', () => {
    expect(parseColorRGBA('rgba(255, 0, 0, 0)')).toEqual([1, 0, 0, 0])
  })

  it('tolerates whitespace inside rgb/rgba functional notation', () => {
    expect(parseColorRGBA('rgb(  10 ,  20 ,  30  )')).toEqual([10 / 255, 20 / 255, 30 / 255, 1])
  })

  it('returns opaque black for malformed input so downstream fills never see NaN', () => {
    expect(parseColorRGBA('not-a-color')).toEqual([0, 0, 0, 1])
    expect(parseColorRGBA('')).toEqual([0, 0, 0, 1])
    expect(parseColorRGBA('rgb(1, 2)')).toEqual([0, 0, 0, 1])
  })

  it('hex channels round-trip cleanly back to 0-255 integers', () => {
    const [r, g, b] = parseColorRGBA('#3b82f6')
    expect([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]).toEqual([0x3b, 0x82, 0xf6])
  })
})

describe('normalizeBorderRadius', () => {
  it('expands a uniform number into all four corners', () => {
    expect(normalizeBorderRadius(8, 100, 100)).toEqual([8, 8, 8, 8])
  })

  it('clamps a uniform number to half the smaller dimension', () => {
    expect(normalizeBorderRadius(999, 40, 100)).toEqual([20, 20, 20, 20])
    expect(normalizeBorderRadius(999, 100, 30)).toEqual([15, 15, 15, 15])
  })

  it('clamps negative uniform input to zero', () => {
    expect(normalizeBorderRadius(-5, 100, 100)).toEqual([0, 0, 0, 0])
  })

  it('expands per-corner object preserving tl/tr/br/bl order', () => {
    expect(normalizeBorderRadius({ topLeft: 1, topRight: 2, bottomRight: 3, bottomLeft: 4 }, 100, 100))
      .toEqual([1, 2, 3, 4])
  })

  it('treats missing corner fields as zero', () => {
    expect(normalizeBorderRadius({ topLeft: 10 }, 100, 100)).toEqual([10, 0, 0, 0])
  })

  it('clamps individual corners independently to the shared max', () => {
    expect(normalizeBorderRadius({ topLeft: 100, topRight: 5, bottomRight: 100, bottomLeft: 2 }, 40, 80))
      .toEqual([20, 5, 20, 2])
  })

  it('returns all zeros for undefined input', () => {
    expect(normalizeBorderRadius(undefined, 100, 100)).toEqual([0, 0, 0, 0])
  })

  it('returns all zeros for an empty per-corner object', () => {
    expect(normalizeBorderRadius({}, 100, 100)).toEqual([0, 0, 0, 0])
  })

  it('handles a zero-sized box without producing NaN', () => {
    expect(normalizeBorderRadius(10, 0, 0)).toEqual([0, 0, 0, 0])
    expect(normalizeBorderRadius({ topLeft: 10, topRight: 10, bottomRight: 10, bottomLeft: 10 }, 0, 100))
      .toEqual([0, 0, 0, 0])
  })
})
