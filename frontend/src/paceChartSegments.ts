import { robustColorScaleRange } from './chartScales'
import { interpCanonicalVzMps } from './distanceUtils'

const SLOPE_BINS = 8
const ALT_SEGMENTS = 28

function lerp(a: number, t: number, b: number) {
  return a + t * (b - a)
}

type RefGrid = { distance_m: (number | null)[]; vz_m_s: (number | null)[] }

/**
 * d(Δt)/ds — Plotly line is one color per path; split by slope bins (red = losing time fast).
 */
export function buildDeltaTSlopeTraces(
  xd: number[],
  yd: number[],
  lineWidth: number,
  name: string,
  legendgroup: string,
): object[] {
  if (xd.length < 2 || yd.length !== xd.length) return []
  const slope: number[] = new Array(xd.length)
  slope[0] = 0
  for (let i = 1; i < xd.length; i++) {
    const ddx = xd[i]! - xd[i - 1]!
    slope[i] = ddx > 1e-9 ? (yd[i]! - yd[i - 1]!) / ddx : slope[i - 1]!
  }
  for (let i = 1; i < slope.length; i++) {
    if (!Number.isFinite(slope[i]!)) slope[i] = slope[i - 1]!
  }
  const rc = robustColorScaleRange(slope, {
    symmetricAroundZero: true,
    highPct: 98,
    minSpan: 1e-6,
    padFraction: 0.12,
  })
  if (!rc) {
    return [
      {
        x: xd,
        y: yd,
        type: 'scatter' as const,
        mode: 'lines' as const,
        name,
        showlegend: true,
        legendgroup,
        line: { color: '#9a3412', width: lineWidth },
        hovertemplate: 'dist %{x:.1f} m · Δt %{y:.3f} s<extra></extra>',
      },
    ]
  }
  const [cmin, cmax] = rc
  const inv = 1 / Math.max(cmax - cmin, 1e-9)
  const binId = (v: number) => {
    if (!Number.isFinite(v)) return 0
    const t = (v - cmin) * inv
    const b = Math.floor(Math.min(0.9999, Math.max(0, t)) * SLOPE_BINS)
    return Math.min(SLOPE_BINS - 1, Math.max(0, b))
  }
  /** Low bin = better (gaining) green tones; high bin = bad red. */
  const colorForBin = (b: number) => {
    const t = b / Math.max(1, SLOPE_BINS - 1)
    const r = Math.round(lerp(22, t, 220))
    const g = Math.round(lerp(163, t, 38))
    const bl = Math.round(lerp(74, t, 38))
    return `rgb(${r},${g},${bl})`
  }

  const traces: object[] = []
  let i0 = 0
  for (let k = 1; k < xd.length; k++) {
    const b0 = binId(slope[k - 1]!)
    const b1 = binId(slope[k]!)
    if (b0 !== b1) {
      const slice = xd.slice(i0, k)
      const sly = yd.slice(i0, k)
      if (slice.length >= 2) {
        const bi = binId(slope[Math.max(i0, k - 2)] ?? 0)
        traces.push({
          x: slice,
          y: sly,
          type: 'scatter' as const,
          mode: 'lines' as const,
          name: traces.length === 0 ? name : ' ',
          showlegend: traces.length === 0,
          legendgroup,
          line: { color: colorForBin(bi), width: lineWidth },
          hovertemplate: 'dist %{x:.1f} m · Δt %{y:.3f} s<extra></extra>',
        })
      }
      i0 = k - 1
    }
  }
  const lastX = xd.slice(i0)
  const lastY = yd.slice(i0)
  if (lastX.length >= 2) {
    const bi = binId(slope[Math.max(0, xd.length - 2)] ?? 0)
    traces.push({
      x: lastX,
      y: lastY,
      type: 'scatter' as const,
      mode: 'lines' as const,
      name: traces.length === 0 ? name : ' ',
      showlegend: traces.length === 0,
      legendgroup,
      line: { color: colorForBin(bi), width: lineWidth },
      hovertemplate: 'dist %{x:.1f} m · Δt %{y:.3f} s<extra></extra>',
    })
  }
  return traces.length > 0
    ? traces
    : [
        {
          x: xd,
          y: yd,
          type: 'scatter' as const,
          mode: 'lines' as const,
          name,
          showlegend: true,
          legendgroup,
          line: { color: '#9a3412', width: lineWidth },
          hovertemplate: 'dist %{x:.1f} m · Δt %{y:.3f} s<extra></extra>',
        },
      ]
}

function vzFlavorRgb(
  refVz: number | null,
  runVz: number | null,
): { r: number; g: number; b: number } | null {
  if (refVz == null || runVz == null || !Number.isFinite(refVz) || !Number.isFinite(runVz)) {
    return null
  }
  
  // Calculate Delta Vz (positive = descending faster)
  const deltaVz = refVz - runVz
  
  // Normalize between -1 and 1
  const u = Math.tanh(deltaVz * 0.4)
  
  const w = { r: 230, g: 230, b: 230 } // Neutral grey/white
  
  if (u > 0) {
    // Deep Blue for descending faster
    const deepB = { r: 30, g: 58, b: 138 } // Tailwind blue-900
    return { 
      r: lerp(w.r, u, deepB.r), 
      g: lerp(w.g, u, deepB.g), 
      b: lerp(w.b, u, deepB.b) 
    }
  } else {
    // Bright Red for descending slower
    const brightR = { r: 220, g: 38, b: 38 } // Tailwind red-600
    return { 
      r: lerp(w.r, Math.abs(u), brightR.r), 
      g: lerp(w.g, Math.abs(u), brightR.g), 
      b: lerp(w.b, Math.abs(u), brightR.b) 
    }
  }
}

/**
 * Altitude line split into segments, each tinted by Vz vs canonical ref (desc: blue, climb: red).
 */
export function buildVzTonedAltitudeTraces(
  x: number[],
  y: number[],
  can: RefGrid,
  getRunVz: (d: number) => number | null,
  runLabel: string,
  runColor: string,
): object[] {
  if (x.length < 2 || y.length !== x.length) {
    return [
      {
        x,
        y,
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: runLabel,
        line: { color: runColor, width: 1.5 },
        opacity: 0.95,
        hovertemplate: `<b>${runLabel}</b><br>dist %{x:.2f} m<br>alt %{y:.2f} m<extra></extra>`,
      },
    ]
  }
  const dmm = can.distance_m
  const vzz = can.vz_m_s
  const n = x.length
  const step = Math.max(1, Math.floor(n / ALT_SEGMENTS))
  const traces: object[] = []
  for (let a = 0; a < n - 1; a += step) {
    const b = Math.min(n, a + step + 1)
    if (b - a < 2) continue
    const xs = x.slice(a, b)
    const ys = y.slice(a, b)
    let acc = 0
    let rSum = 0
    let gSum = 0
    let bSum = 0
    for (let j = 0; j < xs.length; j++) {
      const d = xs[j]!
      const refVz = interpCanonicalVzMps(dmm, vzz, d)
      const runVz = getRunVz(d)
      const rgb = vzFlavorRgb(refVz, runVz)
      if (rgb) {
        rSum += rgb.r
        gSum += rgb.g
        bSum += rgb.b
        acc++
      }
    }
    if (acc === 0) {
      traces.push({
        x: xs,
        y: ys,
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: ' ',
        showlegend: false,
        legendgroup: runLabel,
        line: { color: runColor, width: 1.8 },
        opacity: 0.95,
        hoverinfo: 'skip' as const,
      })
    } else {
      const r = Math.round(rSum / acc)
      const g = Math.round(gSum / acc)
      const bcol = Math.round(bSum / acc)
      traces.push({
        x: xs,
        y: ys,
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: ' ',
        showlegend: false,
        legendgroup: runLabel,
        line: { color: `rgb(${r},${g},${bcol})`, width: 2.2 },
        opacity: 0.95,
        hoverinfo: 'skip' as const,
      })
    }
  }
  
  if (traces.length > 0) {
    // Add one invisible unified trace for hover to avoid multi-segment hover spam
    traces.push({
      x,
      y,
      type: 'scatter' as const,
      mode: 'lines' as const,
      name: ' ',
      showlegend: false,
      line: { color: 'transparent', width: 0 },
      hovertemplate: `<b>${runLabel}</b> (Vz vs ref)<br>dist %{x:.2f} m<br>alt %{y:.2f} m<extra></extra>`,
    })
    
    // Add a dummy trace just for the legend so the user sees Blue/Orange
    traces.push({
      x: [null],
      y: [null],
      type: 'scatter' as const,
      mode: 'lines' as const,
      name: runLabel,
      legendgroup: runLabel,
      showlegend: true,
      line: { color: runColor, width: 2 },
      hoverinfo: 'skip' as const,
    })

    return traces
  }
  
  return [
    {
      x,
      y,
      type: 'scatter' as const,
      mode: 'lines' as const,
      name: runLabel,
      line: { color: runColor, width: 1.5 },
      opacity: 0.95,
      hovertemplate: `<b>${runLabel}</b><br>dist %{x:.2f} m<br>alt %{y:.2f} m<extra></extra>`,
    },
  ]
}
