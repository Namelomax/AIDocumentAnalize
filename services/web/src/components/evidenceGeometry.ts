// Pure bbox -> CSS percentage math, kept out of EvidencePanel so the one
// calculation a rotation/off-by-one bug would hide can be unit-tested
// without a browser or a rendered <img>. The normalized bbox already lives
// in the coordinate system of the rendered page image (0..1 on each axis,
// checked against all four sheet rotations upstream); this function only
// turns those fractions into the CSS the overlay div needs. The overlay's
// containing box must itself match the image's rendered rect pixel-for-
// pixel — EvidencePanel's fitContain wrapper (below) is what guarantees that.
export interface BboxRect {
  left: string;
  top: string;
  width: string;
  height: string;
}

export function bboxToRect([x1, y1, x2, y2]: [number, number, number, number]): BboxRect {
  return {
    left: `${x1 * 100}%`,
    top: `${y1 * 100}%`,
    width: `${(x2 - x1) * 100}%`,
    height: `${(y2 - y1) * 100}%`,
  };
}

export interface Size {
  width: number;
  height: number;
}

// The pixel size an `object-fit: contain` image would render at inside
// `panel`, given the image's own natural size. A CSS-only box (aspect-ratio
// + max-width/max-height, no explicit width/height) collapses to 0x0 when
// none of its children contribute an intrinsic size — every child here
// (the bbox overlay, the value label) is absolutely positioned, so it does.
// Computing the wrapper's pixel size here instead is what keeps it non-zero,
// and it's exactly what the bbox overlay's percentages are then relative to.
export function fitContain(panel: Size, natural: Size): Size {
  if (panel.width <= 0 || panel.height <= 0 || natural.width <= 0 || natural.height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(panel.width / natural.width, panel.height / natural.height);
  return { width: natural.width * scale, height: natural.height * scale };
}
