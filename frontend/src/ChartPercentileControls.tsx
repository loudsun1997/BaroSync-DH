import { CHART_PERCENTILE_DEFAULTS, clampChartPercentilePair } from './chartScales'

type Props = {
  low: number
  high: number
  onChange: (next: { low: number; high: number }) => void
}

export function ChartPercentileControls({ low, high, onChange }: Props) {
  const apply = (nextLow: number, nextHigh: number) => {
    onChange(clampChartPercentilePair(nextLow, nextHigh))
  }

  return (
    <div className="chart-percentile-bar" role="group" aria-label="Chart Y-axis percentile band">
      <span className="chart-percentile-bar-title">Y-axis band</span>
      <div className="chart-percentile-row">
        <label className="chart-percentile-label">
          <span className="chart-percentile-name">Low %</span>
          <input
            type="range"
            min={0}
            max={98}
            value={low}
            onChange={(e) => apply(Number(e.target.value), high)}
            aria-valuemin={0}
            aria-valuemax={98}
            aria-valuenow={low}
          />
          <input
            type="number"
            className="chart-percentile-num"
            min={0}
            max={98}
            step={1}
            value={low}
            onChange={(e) => apply(Number(e.target.value), high)}
          />
        </label>
        <label className="chart-percentile-label">
          <span className="chart-percentile-name">High %</span>
          <input
            type="range"
            min={2}
            max={100}
            value={high}
            onChange={(e) => apply(low, Number(e.target.value))}
            aria-valuemin={2}
            aria-valuemax={100}
            aria-valuenow={high}
          />
          <input
            type="number"
            className="chart-percentile-num"
            min={2}
            max={100}
            step={1}
            value={high}
            onChange={(e) => apply(low, Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          className="chart-percentile-reset link-button"
          onClick={() =>
            onChange({
              low: CHART_PERCENTILE_DEFAULTS.low,
              high: CHART_PERCENTILE_DEFAULTS.high,
            })
          }
        >
          Reset (1–99)
        </button>
      </div>
      <p className="chart-percentile-hint">
        Uses the {low}th–{high}th percentile of plotted Y values (plus padding). Lower high % widens the axis to show
        spikes; higher low % trims quiet tails.
      </p>
    </div>
  )
}
