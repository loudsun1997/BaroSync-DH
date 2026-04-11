/**
 * Wheel = zoom, drag = pan. Hides Plotly’s icon toolbar (box zoom, lasso, etc.).
 */
export const plotlyInteractionConfig = {
  responsive: true,
  displaylogo: false,
  scrollZoom: true,
  displayModeBar: false,
} as const
