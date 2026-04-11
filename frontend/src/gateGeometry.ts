import type { AlignmentMeta, GatePreview, RunResult } from './types'
import { latAt, lonAt, telemetryLen } from './telemetryAccess'

const EARTH_R_M = 6_371_000

/** Cheap degree-space nearest index (fine for picking a trail point). */
export function nearestIndexOnTrail(tel: RunResult['telemetry'], lat: number, lon: number): number {
  const n = telemetryLen(tel)
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < n; i++) {
    const la = latAt(tel, i)
    const lo = lonAt(tel, i)
    const d = (la - lat) * (la - lat) + (lo - lon) * (lo - lon)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

function offsetLatLonM(lat0: number, lon0: number, eastM: number, northM: number): { lat: number; lon: number } {
  const dlat = (northM / EARTH_R_M) * (180 / Math.PI)
  const dlon = (eastM / (EARTH_R_M * Math.cos((lat0 * Math.PI) / 180))) * (180 / Math.PI)
  return { lat: lat0 + dlat, lon: lon0 + dlon }
}

/** Perpendicular segment through trail sample `i` (center), tangent from trail direction. */
export function perpendicularGateLonLat(
  tel: RunResult['telemetry'],
  i: number,
  halfWidthM = 12,
): { lon: [number, number]; lat: [number, number] } | null {
  const n = telemetryLen(tel)
  if (n < 2) return null
  const latc = latAt(tel, i)
  const lonc = lonAt(tel, i)
  let lat0: number
  let lon0: number
  let lat1: number
  let lon1: number
  if (i < n - 1) {
    lat0 = latAt(tel, i)
    lon0 = lonAt(tel, i)
    lat1 = latAt(tel, i + 1)
    lon1 = lonAt(tel, i + 1)
  } else {
    lat0 = latAt(tel, i - 1)
    lon0 = lonAt(tel, i - 1)
    lat1 = latAt(tel, i)
    lon1 = lonAt(tel, i)
  }
  const latm = ((lat0 + lat1) * Math.PI) / 360
  const deast = EARTH_R_M * ((lon1 - lon0) * Math.PI) / 180 * Math.cos(latm)
  const dnorth = EARTH_R_M * ((lat1 - lat0) * Math.PI) / 180
  const hyp = Math.hypot(deast, dnorth) + 1e-9
  const te = deast / hyp
  const tn = dnorth / hyp
  const pe = -tn
  const pn = te
  const a = offsetLatLonM(latc, lonc, -pe * halfWidthM, -pn * halfWidthM)
  const b = offsetLatLonM(latc, lonc, pe * halfWidthM, pn * halfWidthM)
  return { lon: [a.lon, b.lon], lat: [a.lat, b.lat] }
}

export function gateLineFromMeta(alignment: AlignmentMeta | null | undefined): {
  lon: [number, number]
  lat: [number, number]
} | null {
  const lo = alignment?.gate_line_longitude
  const la = alignment?.gate_line_latitude
  if (lo?.length === 2 && la?.length === 2) {
    return { lon: [lo[0], lo[1]], lat: [la[0], la[1]] }
  }
  return null
}

export function gateLineFromPreview(preview: GatePreview | null | undefined): {
  lon: [number, number]
  lat: [number, number]
} | null {
  const lo = preview?.gate_line_longitude
  const la = preview?.gate_line_latitude
  if (lo?.length === 2 && la?.length === 2) {
    return { lon: [lo[0], lo[1]], lat: [la[0], la[1]] }
  }
  return null
}
