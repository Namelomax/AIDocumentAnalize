import { describe, expect, it } from 'vitest';
import { bboxToRect, fitContain } from './evidenceGeometry';

describe('bboxToRect', () => {
  it('converts a normalized bbox into left/top/width/height percentages', () => {
    expect(bboxToRect([0.1, 0.2, 0.3, 0.4])).toEqual({
      left: '10%',
      top: '20%',
      width: '20%',
      height: '20%',
    });
  });

  it('covers the whole page for a bbox spanning [0,0]..[1,1]', () => {
    expect(bboxToRect([0, 0, 1, 1])).toEqual({
      left: '0%',
      top: '0%',
      width: '100%',
      height: '100%',
    });
  });

  it('is expressed relative to the image, not the panel — the caller must place it inside a rect that matches the rendered image', () => {
    // A wide sheet (e.g. 3979x1407) letterboxed inside a tall panel used to
    // leave the bbox positioned against the panel's own box, landing in the
    // padding above the image (Task: fix EvidencePanel bbox misalignment).
    // This function has no opinion on the panel at all — it only ever
    // produces fractions of *some* box, and it's on the caller (the
    // fitContain-sized wrapper in EvidencePanel) to make sure that box is
    // the rendered image.
    const rect = bboxToRect([0.25, 0.6, 0.75, 0.9]);
    expect(rect.left).toBe('25%');
    expect(rect.top).toBe('60%');
    expect(rect.width).toBe('50%');
    // 0.9 - 0.6 lands on a binary-float remainder (30.000000000000004%) —
    // the CSS renders identically, so round-trip through a number for the
    // assertion rather than pin the exact string.
    expect(parseFloat(rect.height)).toBeCloseTo(30);
  });
});

describe('fitContain', () => {
  it('is width-bound for a wide sheet in a tall panel', () => {
    // 3979x1407 (Task's reference wide PD sheet) inside a tall panel.
    const result = fitContain({ width: 400, height: 800 }, { width: 3979, height: 1407 });
    expect(result.width).toBeCloseTo(400);
    expect(result.height).toBeLessThan(800);
    expect(result.height).toBeCloseTo((1407 * 400) / 3979);
  });

  it('is height-bound for a tall sheet in a wide panel', () => {
    const result = fitContain({ width: 800, height: 400 }, { width: 1407, height: 3979 });
    expect(result.height).toBeCloseTo(400);
    expect(result.width).toBeLessThan(800);
    expect(result.width).toBeCloseTo((1407 * 400) / 3979);
  });

  it('fills the panel exactly when the aspect ratios already match', () => {
    const result = fitContain({ width: 800, height: 450 }, { width: 1600, height: 900 });
    expect(result).toEqual({ width: 800, height: 450 });
  });

  it('returns zero, not a division by zero, for a zero-sized panel', () => {
    const result = fitContain({ width: 0, height: 0 }, { width: 3979, height: 1407 });
    expect(result).toEqual({ width: 0, height: 0 });
    expect(Number.isFinite(result.width)).toBe(true);
    expect(Number.isFinite(result.height)).toBe(true);
  });

  it('returns zero for a not-yet-known (zero) natural size too', () => {
    const result = fitContain({ width: 800, height: 600 }, { width: 0, height: 0 });
    expect(result).toEqual({ width: 0, height: 0 });
  });
});
