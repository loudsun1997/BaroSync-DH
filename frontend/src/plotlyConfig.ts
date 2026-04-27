/**
 * Wheel = zoom, drag = pan. Hides Plotly’s icon toolbar (box zoom, lasso, etc.).
 */
export const plotlyInteractionConfig = {
  responsive: true,
  displaylogo: false,
  scrollZoom: true,
  displayModeBar: false,
} as const

/**
 * Distance charts: wheel zoom, visible mode bar (box zoom / pan / reset), double-click resets axes.
 */
export const plotlyDistanceExplorerConfig = {
  responsive: true,
  displaylogo: false,
  scrollZoom: true,
  displayModeBar: true,
  modeBarButtonsToRemove: ['lasso2d', 'select2d'] as const,
  doubleClick: 'reset' as const,
} as const
