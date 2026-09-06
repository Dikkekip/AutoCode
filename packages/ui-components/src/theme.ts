import type { AgentVisualStatus, TimelineTone } from "./types.js"

export interface OpenClawTheme {
  background: string
  backgroundElevated: string
  panel: string
  panelMuted: string
  border: string
  text: string
  textMuted: string
  accent: string
  accentSoft: string
  success: string
  successSoft: string
  warning: string
  warningSoft: string
  danger: string
  dangerSoft: string
  code: string
  shadow: string
}

export const defaultOpenClawTheme: OpenClawTheme = {
  background: "#07131c",
  backgroundElevated: "#0d1923",
  panel: "#101e2a",
  panelMuted: "#162634",
  border: "#274153",
  text: "#e6f2f7",
  textMuted: "#90a8b7",
  accent: "#2bc2db",
  accentSoft: "rgba(43, 194, 219, 0.14)",
  success: "#33d17a",
  successSoft: "rgba(51, 209, 122, 0.14)",
  warning: "#f6b73c",
  warningSoft: "rgba(246, 183, 60, 0.16)",
  danger: "#ff6b6b",
  dangerSoft: "rgba(255, 107, 107, 0.16)",
  code: "#0a141d",
  shadow: "0 24px 80px rgba(0, 0, 0, 0.28)"
}

export function statusAccent(theme: OpenClawTheme, status: AgentVisualStatus): string {
  switch (status) {
    case "running":
    case "streaming":
    case "queued":
      return theme.accent
    case "completed":
      return theme.success
    case "error":
    case "offline":
      return theme.danger
    case "paused":
      return theme.warning
    default:
      return theme.textMuted
  }
}

export function toneAccent(theme: OpenClawTheme, tone: TimelineTone): string {
  switch (tone) {
    case "info":
      return theme.accent
    case "success":
      return theme.success
    case "warn":
      return theme.warning
    case "error":
      return theme.danger
    default:
      return theme.textMuted
  }
}
