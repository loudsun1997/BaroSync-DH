import { useMemo } from 'react'
import { canCompareVerticalSpeed, compareVerticalSpeedTwoRuns } from './verticalSpeedCompare'
import type { RunResult } from './types'

type Props = {
  runs: RunResult[]
}

function pct(n: number, d: number): string {
  if (d <= 0) return '0'
  return ((100 * n) / d).toFixed(1)
}

export function VerticalSpeedCompareSummary({ runs }: Props) {
  const result = useMemo(() => {
    if (!canCompareVerticalSpeed(runs)) return null
    return compareVerticalSpeedTwoRuns(runs[0]!, runs[1]!, {
      tieEpsM_s: 0.08,
      descentCutM_s: -0.25,
    })
  }, [runs])

  if (result == null) return null

  const la = runs[0]!.label ?? 'First run'
  const lb = runs[1]!.label ?? 'Second run'
  const {
    samples,
    aLowerVzCount,
    bLowerVzCount,
    tieCount,
    overlapLengthM,
    gridStepM,
    tieEpsM_s,
    meanAbsDiffM_s,
    descentCutM_s,
    descentSamples,
    descentALowerVzCount,
    descentBLowerVzCount,
    descentTieCount,
  } = result

  return (
    <section className="vz-compare-summary" aria-label="Automatic vertical speed comparison">
      <h3 className="vz-compare-summary-title">Vertical speed (auto)</h3>
      <p className="vz-compare-summary-body">
        Every <strong>{gridStepM} m</strong> along <strong>{overlapLengthM.toFixed(0)} m</strong> of overlapping
        distance we interpolate display Vz for each lap at that <em>same</em> distance — one value per lap per
        point (no mixing up/down inside a single sample). Along a full lap, though, some points are on climbs and
        some on descents, so read the two blocks below.
      </p>

      {descentSamples > 0 ? (
        <>
          <p className="vz-compare-summary-subhead">Downhill-only samples</p>
          <p className="vz-compare-summary-body">
            Only points where <strong>both</strong> laps have Vz ≤ <strong>{descentCutM_s}</strong> m/s (clearly
            descending). Here <strong>more negative = dropping faster</strong>.
          </p>
          <ul className="vz-compare-summary-list">
            <li>
              <strong>{la}</strong> dropping faster at <strong>{descentALowerVzCount}</strong> spots (
              {pct(descentALowerVzCount, descentSamples)}% of {descentSamples} downhill samples)
            </li>
            <li>
              <strong>{lb}</strong> dropping faster at <strong>{descentBLowerVzCount}</strong> spots (
              {pct(descentBLowerVzCount, descentSamples)}%)
            </li>
            <li>
              Rough tie (|ΔVz| &lt; <strong>{tieEpsM_s}</strong> m/s) at <strong>{descentTieCount}</strong> spots (
              {pct(descentTieCount, descentSamples)}%)
            </li>
          </ul>
        </>
      ) : (
        <p className="vz-compare-summary-note">
          No grid points where both laps are clearly descending (Vz ≤ {descentCutM_s} m/s) together — use the full
          overlap block below, or a finer trail / different laps.
        </p>
      )}

      <p className="vz-compare-summary-subhead">All overlap samples</p>
      <p className="vz-compare-summary-body">
        Includes flats and climbs. We still ask who has <strong>more negative Vz</strong> at each distance — on a
        climb that means “less upward / slower climb,” not “faster descent.”
      </p>
      <ul className="vz-compare-summary-list">
        <li>
          <strong>{la}</strong> more negative Vz at <strong>{aLowerVzCount}</strong> spots ({pct(aLowerVzCount, samples)}
          % of {samples} samples)
        </li>
        <li>
          <strong>{lb}</strong> more negative Vz at <strong>{bLowerVzCount}</strong> spots ({pct(bLowerVzCount, samples)}
          %)
        </li>
        <li>
          Rough tie (|ΔVz| &lt; <strong>{tieEpsM_s}</strong> m/s) at <strong>{tieCount}</strong> spots (
          {pct(tieCount, samples)}%)
        </li>
      </ul>
      <p className="vz-compare-summary-foot">
        Mean |ΔVz| between laps at sample points: <strong>{meanAbsDiffM_s.toFixed(3)} m/s</strong>. Hover altitude
        markers for exact Vz at a distance. Trail color <strong>Lap compare — run 1 solid line, run 2 heat vs baseline</strong>:
        run 1 is a single-color line; run 2 is the heatmap vs baseline (orange = faster down, blue = slower).
      </p>
      {runs.length > 2 && (
        <p className="vz-compare-summary-note">Only the first two runs in the list are compared here.</p>
      )}
    </section>
  )
}
