import type { AlignmentMeta, GatePreview, TelemetryPoint } from './types'

const EARTH_R_M = 6_371_000

/** Cheap degree-space nearest index (fine for picking a trail point). */
export function nearestIndexOnTrail(tel: TelemetryPoint[], lat: number, lon: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < tel.length; i++) {
    const d =
      (tel[i].latitude - lat) * (tel[i].latitude - lat) +
      (tel[i].longitude - lon) * (tel[i].longitude - lon)
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
  tel: TelemetryPoint[],
  i: number,
  halfWidthM = 12,
): { lon: [number, number]; lat: [number, number] } | null {
  if (tel.length < 2) return null
  const latc = tel[i].latitude
  const lonc = tel[i].longitude
  let lat0: number
  let lon0: number
  let lat1: number
  let lon1: number
  if (i < tel.length - 1) {
    lat0 = tel[i].latitude
    lon0 = tel[i].longitude
    lat1 = tel[i + 1].latitude
    lon1 = tel[i + 1].longitude
  } else {
    lat0 = tel[i - 1].latitude
    lon0 = tel[i - 1].longitude
    lat1 = tel[i].latitude
    lon1 = tel[i].longitude
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
