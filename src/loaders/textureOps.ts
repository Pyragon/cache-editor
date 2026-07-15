// The texture "material" in this cache is not a stored image — it's a small
// program: a DAG of operations that the client evaluates per-pixel to produce
// the texture. Each node has a `type` (0-39) selecting the operation, its own
// parameters, and N inputs wired to other nodes by index (`operationIndices`).
//
// Names, defaults and semantics all come from darkan-bot-refactor's
// config/material/texture/operation/TextureOp*.kt (cryogen's classes were
// renamed to match). Fixed-point values are 12-bit: 4096 == 1.0.

export type OpFieldKind = 'int' | 'bool' | 'select' | 'color' | 'points' | 'stops' | 'shorts' | 'shapes' | 'sprite' | 'material'

export type OpField = {
  key: string
  label: string
  kind: OpFieldKind
  /** for kind: 'select' */
  options?: Record<number, string>
  hint?: string
}

export type OpType = {
  name: string
  /** what each wired input feeds; length == the node's input count */
  inputs: string[]
  fields: OpField[]
  hint?: string
}

// The values each op's constructor starts from in cryogen. A new node has to be
// born with these: encode() omits any field still at its default, so a node built
// from anything else would write opcodes the original never had. `monochrome` is a
// constructor argument rather than a field, hence the separate map.
export const OP_DEFAULTS: Record<number, { monochrome: boolean; fields: Record<string, unknown> }> = {
  0: { monochrome: true, fields: { fillValue: 4096 } },
  1: { monochrome: false, fields: { value: 0 } },
  2: { monochrome: true, fields: {} },
  3: { monochrome: true, fields: {} },
  4: { monochrome: true, fields: { columnsPerRow: 4, rowCount: 8, verticalOffset: 0, staggerAmount: 1024, brightnessVariation: 1024, columnWidthVariation: 409, rowHeightVariation: 204, mortarThickness: 81 } },
  5: { monochrome: false, fields: { radiusX: 1, radiusY: 1 } },
  6: { monochrome: false, fields: { minValue: 0, maxValue: 4096 } },
  7: { monochrome: false, fields: { blendMode: 6 } },
  // controlPoints must never be null — encode() reads its length unconditionally.
  8: { monochrome: true, fields: { interpolationMode: 0, controlPoints: [[0, 0], [4096, 4096]] } },
  9: { monochrome: false, fields: { mirrorHorizontally: true, mirrorVertically: true } },
  // cryogen's postDecode falls back to preset 1 when no stops were stored, so a new
  // node starts as that preset rather than as an empty custom gradient.
  10: { monochrome: false, fields: { presetId: 1, colorStops: [[0, 0, 0, 0], [4096, 4096, 4096, 4096]] } },
  11: { monochrome: false, fields: { redMultiplier: 4096, greenMultiplier: 4096, blueMultiplier: 4096 } },
  12: { monochrome: true, fields: { waveType: 0, waveShape: 0, frequency: 1 } },
  13: { monochrome: true, fields: {} },
  14: { monochrome: true, fields: { threadWidth: 585 } },
  15: { monochrome: true, fields: { randomSeed: 0, pointJitter: 2048, cellCountX: 5, cellCountY: 5, distanceOutputMode: 2, distanceMetric: 1 } },
  16: { monochrome: true, fields: { scaleX: 1, scaleY: 1, threshold: 204 } },
  17: { monochrome: false, fields: { hueAdjust: 0, saturationAdjust: 0, lightnessAdjust: 0 } },
  18: { monochrome: false, fields: { spriteId: -1 } },
  19: { monochrome: false, fields: { distortionStrength: 32768 } },
  20: { monochrome: false, fields: { tileCountX: 4, tileCountY: 4 } },
  21: { monochrome: false, fields: {} },
  22: { monochrome: false, fields: {} },
  23: { monochrome: false, fields: {} },
  24: { monochrome: true, fields: {} },
  25: { monochrome: false, fields: { blueBrightness: 4096, greenBrightness: 4096, redBrightness: 4096, colorTolerance: 409, color: 0 } },
  26: { monochrome: true, fields: { lowerThreshold: 0, upperThreshold: 4096 } },
  27: { monochrome: true, fields: { stepCount: 10, dutyCycle: 2048, waveAxis: 0 } },
  28: { monochrome: true, fields: { randomSeed: 0, minBrickWidth: 1024, maxBrickWidth: 2048, minBrickHeight: 409, maxBrickHeight: 819, offsetVariation: 1024, cornerMode: 0, heightVariationMultiplier: 1024, brightnessVariation: 1024 } },
  29: { monochrome: true, fields: { shapes: [] } },
  30: { monochrome: false, fields: { rangeOffset: 1024, rangeMax: 3072 } },
  31: { monochrome: true, fields: { centerX: 0, centerY: 0, zoom: 1365, maxIterations: 20 } },
  32: { monochrome: true, fields: { embossDepth: 4096, lightAzimuth: 3216, lightElevation: 3216 } },
  33: { monochrome: false, fields: { normalized: true, strength: 4096 } },
  34: { monochrome: true, fields: { numNoiseSteps: 4, noiseAmplitude: 1638, texCoordScaleX: 4, texCoordScaleY: 4, randomSeed: 0, useFogEffect: true } },
  35: { monochrome: true, fields: { strength: 4096 } },
  36: { monochrome: false, fields: { materialId: -1 } },
  37: { monochrome: true, fields: { pattern1OffsetX: 2048, pattern1OffsetY: 0, pattern2OffsetX: 0, pattern2OffsetY: 2048, waveFrequency: 12288, waveAmplitude: 4096, waveDecay: 8192 } },
  38: { monochrome: true, fields: { randomSeed: 0, lineCount: 2000, lineLength: 16, angleOffset: 0, angleSpread: 4096 } },
  39: { monochrome: false, fields: { spriteId: -1 } },
}

/** A fresh node of the given op type, at cryogen's constructor defaults. */
export function newOperation(type: number): Record<string, unknown> {
  const spec = OP_DEFAULTS[type]
  return {
    type,
    monochrome: spec?.monochrome ?? true,
    // How many output rows the client caches for this node. Consumers that read
    // neighbouring rows (blur, emboss, edge detect) need this raised on the node
    // they read FROM; 1 is what most nodes in the cache use.
    imageCacheCapacity: 1,
    ...(spec?.fields ?? {}),
  }
}

const FIXED = '4096 = 1.0'

// A node's output is either a single monochrome channel or three colour channels;
// `monochrome` says which, and for many ops it is a real cache field the artist set.
const MONO: OpField = { key: 'monochrome', label: 'Monochrome', kind: 'bool', hint: 'Output is a single channel rather than RGB' }

export const OP_TYPES: Record<number, OpType> = {
  0: { name: 'Monochrome Fill', inputs: [], fields: [{ key: 'fillValue', label: 'Fill Value', kind: 'int', hint: FIXED }, MONO] },
  1: { name: 'Colour Fill', inputs: [], fields: [{ key: 'value', label: 'Colour', kind: 'color' }, MONO] },
  2: { name: 'Horizontal Gradient', inputs: [], fields: [MONO] },
  3: { name: 'Vertical Gradient', inputs: [], fields: [MONO] },
  4: {
    name: 'Bricks',
    inputs: [],
    fields: [
      { key: 'columnsPerRow', label: 'Columns / Row', kind: 'int' },
      { key: 'rowCount', label: 'Rows', kind: 'int' },
      { key: 'mortarThickness', label: 'Mortar Thickness', kind: 'int', hint: FIXED },
      { key: 'staggerAmount', label: 'Stagger', kind: 'int', hint: FIXED },
      { key: 'verticalOffset', label: 'Vertical Offset', kind: 'int' },
      { key: 'columnWidthVariation', label: 'Column Width Variation', kind: 'int', hint: FIXED },
      { key: 'rowHeightVariation', label: 'Row Height Variation', kind: 'int', hint: FIXED },
      { key: 'brightnessVariation', label: 'Brightness Variation', kind: 'int', hint: FIXED },
      MONO,
    ],
  },
  5: { name: 'Box Blur', inputs: ['Source'], fields: [{ key: 'radiusX', label: 'Radius X', kind: 'int' }, { key: 'radiusY', label: 'Radius Y', kind: 'int' }, MONO] },
  6: { name: 'Clamp', inputs: ['Source'], fields: [{ key: 'minValue', label: 'Min', kind: 'int', hint: FIXED }, { key: 'maxValue', label: 'Max', kind: 'int', hint: FIXED }, MONO] },
  7: {
    name: 'Combine',
    inputs: ['A', 'B'],
    fields: [
      {
        key: 'blendMode',
        label: 'Blend Mode',
        kind: 'select',
        options: { 1: 'Add (A + B)', 2: 'Subtract (A − B)', 3: 'Multiply', 4: 'Divide (A / B)', 5: 'Screen', 6: 'Hard Light', 7: 'Mode 7' },
      },
      MONO,
    ],
  },
  8: {
    name: 'Curve',
    inputs: ['Source'],
    fields: [
      { key: 'interpolationMode', label: 'Interpolation', kind: 'select', options: { 0: 'Stepped', 1: 'Linear', 2: 'Spline' } },
      { key: 'controlPoints', label: 'Control Points', kind: 'points', hint: 'input → output, both 0…4096' },
      MONO,
    ],
  },
  9: { name: 'Flip', inputs: ['Source'], fields: [{ key: 'mirrorHorizontally', label: 'Mirror Horizontally', kind: 'bool' }, { key: 'mirrorVertically', label: 'Mirror Vertically', kind: 'bool' }, MONO] },
  10: {
    name: 'Colour Gradient',
    inputs: ['Source'],
    fields: [
      { key: 'presetId', label: 'Preset', kind: 'select', options: { 0: 'Custom stops', 1: 'Black → white', 2: 'Preset 2', 3: 'Preset 3', 4: 'Preset 4', 5: 'Preset 5' }, hint: 'Non-zero presets ignore the stops below' },
      { key: 'colorStops', label: 'Colour Stops', kind: 'stops' },
      MONO,
    ],
  },
  11: { name: 'Colourize', inputs: ['Source'], fields: [{ key: 'redMultiplier', label: 'Red ×', kind: 'int', hint: FIXED }, { key: 'greenMultiplier', label: 'Green ×', kind: 'int', hint: FIXED }, { key: 'blueMultiplier', label: 'Blue ×', kind: 'int', hint: FIXED }, MONO] },
  12: { name: 'Waveform', inputs: [], fields: [{ key: 'waveType', label: 'Axis', kind: 'select', options: { 0: 'Horizontal', 1: 'Vertical' } }, { key: 'waveShape', label: 'Shape', kind: 'select', options: { 0: 'Sine', 1: 'Sawtooth', 2: 'Triangle' } }, { key: 'frequency', label: 'Frequency', kind: 'int' }, MONO] },
  13: { name: 'Noise', inputs: [], fields: [MONO] },
  14: { name: 'Weave', inputs: [], fields: [{ key: 'threadWidth', label: 'Thread Width', kind: 'int', hint: FIXED }, MONO] },
  15: {
    name: 'Voronoi Noise',
    inputs: [],
    fields: [
      { key: 'cellCountX', label: 'Cells X', kind: 'int' },
      { key: 'cellCountY', label: 'Cells Y', kind: 'int' },
      { key: 'pointJitter', label: 'Point Jitter', kind: 'int', hint: FIXED },
      { key: 'randomSeed', label: 'Seed', kind: 'int' },
      { key: 'distanceMetric', label: 'Distance Metric', kind: 'select', options: { 1: 'Euclidean²', 2: 'Manhattan', 3: 'Chebyshev' } },
      { key: 'distanceOutputMode', label: 'Output', kind: 'select', options: { 0: 'F1 (nearest)', 1: 'F2', 2: 'F2 − F1', 3: 'F3', 4: 'F4' } },
      MONO,
    ],
  },
  16: { name: 'Herringbone', inputs: [], fields: [{ key: 'scaleX', label: 'Scale X', kind: 'int' }, { key: 'scaleY', label: 'Scale Y', kind: 'int' }, { key: 'threshold', label: 'Threshold', kind: 'int', hint: FIXED }, MONO] },
  17: { name: 'HSL Adjust', inputs: ['Source'], fields: [{ key: 'hueAdjust', label: 'Hue ±', kind: 'int', hint: FIXED }, { key: 'saturationAdjust', label: 'Saturation ±', kind: 'int', hint: FIXED }, { key: 'lightnessAdjust', label: 'Lightness ±', kind: 'int', hint: FIXED }, MONO] },
  18: { name: 'Tiled Sprite', inputs: [], fields: [{ key: 'spriteId', label: 'Sprite', kind: 'sprite' }, MONO] },
  19: { name: 'Polar Distortion', inputs: ['Source', 'Angle', 'Radius'], fields: [{ key: 'distortionStrength', label: 'Strength', kind: 'int' }, MONO] },
  20: { name: 'Tile', inputs: ['Source'], fields: [{ key: 'tileCountX', label: 'Tiles X', kind: 'int' }, { key: 'tileCountY', label: 'Tiles Y', kind: 'int' }, MONO] },
  21: { name: 'Interpolate', inputs: ['A', 'B', 'Blend'], fields: [MONO], hint: 'Mixes A and B using the Blend input as the weight' },
  22: { name: 'Invert', inputs: ['Source'], fields: [MONO] },
  23: { name: 'Kaleidoscope', inputs: ['Source'], fields: [MONO] },
  24: { name: 'Monochrome', inputs: ['Source'], fields: [MONO], hint: 'Desaturates its input' },
  25: {
    name: 'Brightness',
    inputs: ['Source'],
    fields: [
      { key: 'color', label: 'Target Colour', kind: 'color' },
      { key: 'colorTolerance', label: 'Tolerance', kind: 'int', hint: FIXED },
      { key: 'redBrightness', label: 'Red Brightness', kind: 'int', hint: FIXED },
      { key: 'greenBrightness', label: 'Green Brightness', kind: 'int', hint: FIXED },
      { key: 'blueBrightness', label: 'Blue Brightness', kind: 'int', hint: FIXED },
      MONO,
    ],
  },
  26: { name: 'Binary', inputs: ['Source'], fields: [{ key: 'lowerThreshold', label: 'Lower Threshold', kind: 'int', hint: FIXED }, { key: 'upperThreshold', label: 'Upper Threshold', kind: 'int', hint: FIXED }, MONO] },
  27: { name: 'Square Waveform', inputs: [], fields: [{ key: 'stepCount', label: 'Steps', kind: 'int' }, { key: 'dutyCycle', label: 'Duty Cycle', kind: 'int', hint: FIXED }, { key: 'waveAxis', label: 'Axis', kind: 'select', options: { 0: 'Horizontal', 1: 'Vertical' } }, MONO] },
  28: {
    name: 'Irregular Bricks',
    inputs: [],
    fields: [
      { key: 'minBrickWidth', label: 'Min Brick Width', kind: 'int', hint: FIXED },
      { key: 'maxBrickWidth', label: 'Max Brick Width', kind: 'int', hint: FIXED },
      { key: 'minBrickHeight', label: 'Min Brick Height', kind: 'int', hint: FIXED },
      { key: 'maxBrickHeight', label: 'Max Brick Height', kind: 'int', hint: FIXED },
      { key: 'offsetVariation', label: 'Offset Variation', kind: 'int', hint: FIXED },
      { key: 'heightVariationMultiplier', label: 'Height Variation ×', kind: 'int', hint: FIXED },
      { key: 'brightnessVariation', label: 'Brightness Variation', kind: 'int', hint: FIXED },
      { key: 'cornerMode', label: 'Corner Mode', kind: 'int' },
      { key: 'randomSeed', label: 'Seed', kind: 'int' },
      MONO,
    ],
  },
  29: { name: 'Rasterizer', inputs: [], fields: [{ key: 'shapes', label: 'Shapes', kind: 'shapes' }, MONO] },
  30: { name: 'Range', inputs: ['Source'], fields: [{ key: 'rangeOffset', label: 'Range Offset', kind: 'int', hint: FIXED }, { key: 'rangeMax', label: 'Range Max', kind: 'int', hint: FIXED }, MONO] },
  31: { name: 'Mandelbrot', inputs: [], fields: [{ key: 'zoom', label: 'Zoom', kind: 'int' }, { key: 'maxIterations', label: 'Max Iterations', kind: 'int' }, { key: 'centerX', label: 'Centre X', kind: 'int' }, { key: 'centerY', label: 'Centre Y', kind: 'int' }, MONO] },
  32: { name: 'Emboss', inputs: ['Source'], fields: [{ key: 'embossDepth', label: 'Depth', kind: 'int', hint: FIXED }, { key: 'lightAzimuth', label: 'Light Azimuth', kind: 'int' }, { key: 'lightElevation', label: 'Light Elevation', kind: 'int' }, MONO] },
  33: { name: 'Colour Edge Detector', inputs: ['Source'], fields: [{ key: 'strength', label: 'Strength', kind: 'int', hint: FIXED }, { key: 'normalized', label: 'Normalized', kind: 'bool' }, MONO] },
  34: {
    name: 'Perlin Noise',
    inputs: [],
    fields: [
      { key: 'numNoiseSteps', label: 'Octaves', kind: 'int' },
      { key: 'noiseAmplitude', label: 'Amplitude', kind: 'int', hint: 'Negative means the per-octave multipliers below are used' },
      { key: 'stepMultipliers', label: 'Octave Multipliers', kind: 'shorts' },
      { key: 'texCoordScaleX', label: 'Scale X', kind: 'int' },
      { key: 'texCoordScaleY', label: 'Scale Y', kind: 'int' },
      { key: 'randomSeed', label: 'Seed', kind: 'int' },
      { key: 'useFogEffect', label: 'Fog Effect', kind: 'bool' },
      MONO,
    ],
  },
  35: { name: 'Monochrome Edge Detector', inputs: ['Source'], fields: [{ key: 'strength', label: 'Strength', kind: 'int', hint: FIXED }, MONO] },
  36: { name: 'Texture', inputs: [], fields: [{ key: 'materialId', label: 'Material', kind: 'material' }, MONO], hint: 'Renders another texture and samples it' },
  37: {
    name: 'Op 37',
    inputs: [],
    fields: [
      { key: 'pattern1OffsetX', label: 'Pattern 1 Offset X', kind: 'int' },
      { key: 'pattern1OffsetY', label: 'Pattern 1 Offset Y', kind: 'int' },
      { key: 'pattern2OffsetX', label: 'Pattern 2 Offset X', kind: 'int' },
      { key: 'pattern2OffsetY', label: 'Pattern 2 Offset Y', kind: 'int' },
      { key: 'waveFrequency', label: 'Wave Frequency', kind: 'int' },
      { key: 'waveAmplitude', label: 'Wave Amplitude', kind: 'int' },
      { key: 'waveDecay', label: 'Wave Decay', kind: 'int' },
      MONO,
    ],
    hint: 'Unnamed in darkan too — an interference/ripple pattern',
  },
  38: {
    name: 'Line Noise',
    inputs: [],
    fields: [
      { key: 'lineCount', label: 'Lines', kind: 'int' },
      { key: 'lineLength', label: 'Line Length', kind: 'int' },
      { key: 'angleOffset', label: 'Angle Offset', kind: 'int' },
      { key: 'angleSpread', label: 'Angle Spread', kind: 'int' },
      { key: 'randomSeed', label: 'Seed', kind: 'int' },
      MONO,
    ],
  },
  39: { name: 'Sprite', inputs: [], fields: [{ key: 'spriteId', label: 'Sprite', kind: 'sprite' }, MONO] },
}

export function opName(type: number): string {
  return OP_TYPES[type]?.name ?? `Unknown op ${type}`
}

// Shape kinds inside a Rasterizer op (type 29), tagged by `shapeType`.
export const SHAPE_TYPES: Record<number, { name: string; fields: [string, string][] }> = {
  0: { name: 'Line', fields: [['startX', 'Start X'], ['startY', 'Start Y'], ['endX', 'End X'], ['endY', 'End Y']] },
  1: {
    name: 'Bezier Curve',
    fields: [
      ['controlX0', 'P0 X'], ['controlY0', 'P0 Y'],
      ['controlX1', 'P1 X'], ['controlY1', 'P1 Y'],
      ['controlX2', 'P2 X'], ['controlY2', 'P2 Y'],
      ['controlX3', 'P3 X'], ['controlY3', 'P3 Y'],
    ],
  },
  2: { name: 'Rectangle', fields: [['left', 'Left'], ['top', 'Top'], ['right', 'Right'], ['bottom', 'Bottom']] },
  3: { name: 'Ellipse', fields: [['centerX', 'Centre X'], ['centerY', 'Centre Y'], ['radiusX', 'Radius X'], ['radiusY', 'Radius Y']] },
}
