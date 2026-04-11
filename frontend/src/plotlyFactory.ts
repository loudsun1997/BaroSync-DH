/* eslint-disable @typescript-eslint/no-explicit-any -- plotly wrapper; props are PlotParams */
/**
 * Vite + React 19: default import from react-plotly.js can be `{ default: Component }`
 * instead of the component function, which triggers "Element type is invalid ... got: object".
 */
import type { ComponentType } from 'react'
import ReactPlotly from 'react-plotly.js'

export const Plot = ((): ComponentType<any> => {
  if (typeof ReactPlotly === 'function') {
    return ReactPlotly as unknown as ComponentType<any>
  }
  const d = (ReactPlotly as unknown as { default?: unknown }).default
  if (typeof d === 'function') {
    return d as ComponentType<any>
  }
  throw new Error('react-plotly.js: could not resolve Plot component')
})()
