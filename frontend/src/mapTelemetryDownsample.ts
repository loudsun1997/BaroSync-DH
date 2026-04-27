/**
 * Viewport-aware downsampling for GPS scatter traces so Plotly stays responsive
 * on huge exports while zooming in reveals more detail.
 * Full telemetry stays in memory; only rendered point count is reduced.
 */

export type LonLatViewBox = {
  lonMin: number
  lonMax: number
  latMin: number
  latMax: number
}

export const MIN_MAP_VIEW_POINTS = 2_000
export const MAX_MAP_VIEW_POINTS = 24_000

const MIN_MAP_POINTS = MIN_MAP_VIEW_POINTS
const MAX_MAP_POINTS = MAX_MAP_VIEW_POINTS
const BOX_PAD_FRAC = 0.04

/** ~max points to draw for this lon/lat window (tighter view → more points, capped). */
export function mapPointBudgetForViewBox(box: LonLatViewBox): number {
  const { lonMin, lonMax, latMin, latMax } = box
  const midLat = (latMin + latMax) / 2
  const latKm = Math.abs(latMax - latMin) * 111
  const lonKm = Math.abs(lonMax - lonMin) * 111 * Math.max(Math.cos((midLat * Math.PI) / 180), 0.25)
  const spanKm = Math.max(latKm, lonKm, 0.02)
  const raw = Math.floor(750_000 / spanKm)
  return Math.min(MAX_MAP_POINTS, Math.max(MIN_MAP_POINTS, raw))
}

export function padViewBox(box: LonLatViewBox): LonLatViewBox {
  const lx = box.lonMax - box.lonMin
  const ly = box.latMax - box.latMin
  const px = lx * BOX_PAD_FRAC
  const py = ly * BOX_PAD_FRAC
  return {
    lonMin: box.lonMin - px,
    lonMax: box.lonMax + px,
    latMin: box.latMin - py,
    latMax: box.latMax + py,
  }
}

export function indicesInViewBox(
  lon: number[],
  lat: number[],
  box: LonLatViewBox,
): number[] {
  const { lonMin, lonMax, latMin, latMax } = box
  const out: number[] = []
  for (let i = 0; i < lon.length; i++) {
    const lo = lon[i]!
    const la = lat[i]!
    if (!Number.isFinite(lo) || !Number.isFinite(la)) continue
    if (lo >= lonMin && lo <= lonMax && la >= latMin && la <= latMax) out.push(i)
  }
  return out
}

/** Uniform stride over full series when nothing falls in the box (degenerate zoom). */
export function strideIndices(n: number, maxPts: number): number[] {
  if (n <= 0) return []
  if (n <= maxPts) return Array.from({ length: n }, (_, i) => i)
  const step = Math.ceil(n / maxPts)
  const out: number[] = []
  for (let i = 0; i < n; i += step) out.push(i)
  const li = n - 1
  if (out[out.length - 1] !== li) out.push(li)
  return out
}

export function pickIndices(indices: number[], maxPts: number): number[] {
  if (indices.length <= maxPts) return indices
  const step = Math.ceil(indices.length / maxPts)
  const out: number[] = []
  for (let j = 0; j < indices.length; j += step) out.push(indices[j]!)
  const last = indices[indices.length - 1]!
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/**
 * Choose indices for a lon/lat trace: points inside filterBox (padded), then capped to `budget`.
 * If filterBox is null, uniform stride over the full series.
 */
export function pickLonLatTrace(
  lon: number[],
  lat: number[],
  budget: number,
  filterBox: LonLatViewBox | null,
): { lon: number[]; lat: number[]; idx: number[] } {
  const n = lon.length
  if (n === 0) return { lon: [], lat: [], idx: [] }
  let idx: number[]
  if (!filterBox) {
    idx = strideIndices(n, budget)
  } else {
    let inBox = indicesInViewBox(lon, lat, filterBox)
    if (inBox.length === 0) inBox = strideIndices(n, Math.min(budget, MIN_MAP_POINTS))
    idx = pickIndices(inBox, budget)
  }
  return {
    lon: idx.map((i) => lon[i]!),
    lat: idx.map((i) => lat[i]!),
    idx,
  }
}

export function mapRelayoutToViewBox(ev: Record<string, unknown>): LonLatViewBox | null {
  let x0: number | undefined
  let x1: number | undefined
  let y0: number | undefined
  let y1: number | undefined

  const xr = ev['xaxis.range']
  if (Array.isArray(xr) && xr.length >= 2) {
    x0 = Number(xr[0])
    x1 = Number(xr[1])
  }
  if (typeof ev['xaxis.range[0]'] === 'number') x0 = ev['xaxis.range[0]'] as number
  if (typeof ev['xaxis.range[1]'] === 'number') x1 = ev['xaxis.range[1]'] as number

  const yr = ev['yaxis.range']
  if (Array.isArray(yr) && yr.length >= 2) {
    y0 = Number(yr[0])
    y1 = Number(yr[1])
  }
  if (typeof ev['yaxis.range[0]'] === 'number') y0 = ev['yaxis.range[0]'] as number
  if (typeof ev['yaxis.range[1]'] === 'number') y1 = ev['yaxis.range[1]'] as number

  if (
    x0 != null &&
    x1 != null &&
    y0 != null &&
    y1 != null &&
    Number.isFinite(x0) &&
    Number.isFinite(x1) &&
    Number.isFinite(y0) &&
    Number.isFinite(y1)
  ) {
    return {
      lonMin: Math.min(x0, x1),
      lonMax: Math.max(x0, x1),
      latMin: Math.min(y0, y1),
      latMax: Math.max(y0, y1),
    }
  }
  return null
}
