import { type CSSProperties, type ReactNode, useMemo, useState } from "react"
import { defaultOpenClawTheme, type OpenClawTheme, statusAccent, toneAccent } from "./theme.js"
import type {
  AgentConversationLane,
  AgentTimelineEntry,
  AgentVisualStatus,
  ParallelAgentConsoleData,
  ThinkingTimelineEntry,
  TimelineTone,
  ToolTimelineEntry,
  TransitionTimelineEntry
} from "./types.js"
import { formatTimeLabel, relativeTime } from "./utils.js"

function mergeStyles(...styles: Array<CSSProperties | undefined>): CSSProperties {
  return Object.assign({}, ...styles)
}

const monoFont = "'Cascadia Code', 'SF Mono', 'Fira Code', 'Menlo', monospace"
const sansFont = "ui-sans-serif, system-ui, sans-serif"

function baseCard(theme: OpenClawTheme): CSSProperties {
  return {
    background: theme.panel,
    border: `1px solid ${theme.border}`,
    borderRadius: 18,
    boxShadow: theme.shadow
  }
}

function labelStyle(theme: OpenClawTheme): CSSProperties {
  return {
    color: theme.textMuted,
    fontFamily: monoFont,
    fontSize: 11,
    letterSpacing: "0.08em",
    textTransform: "uppercase"
  }
}

export function StatusPill(props: { status: AgentVisualStatus; theme?: OpenClawTheme; style?: CSSProperties }) {
  const theme = props.theme ?? defaultOpenClawTheme
  const accent = statusAccent(theme, props.status)
  return (
    <span
      style={mergeStyles(
        {
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          borderRadius: 999,
          padding: "6px 10px",
          fontFamily: monoFont,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          background: `${accent}22`,
          color: accent,
          border: `1px solid ${accent}55`
        },
        props.style
      )}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: accent,
          boxShadow: `0 0 18px ${accent}`
        }}
      />
      {props.status}
    </span>
  )
}

export function InternalMonologueCard(props: {
  entry: ThinkingTimelineEntry
  theme?: OpenClawTheme
  defaultOpen?: boolean
}) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <details
      open={props.defaultOpen}
      style={mergeStyles(baseCard(theme), {
        overflow: "hidden",
        background: `linear-gradient(180deg, ${theme.accentSoft}, transparent 42%), ${theme.panel}`
      })}
    >
      <summary
        style={{
          listStyle: "none",
          cursor: "pointer",
          padding: "12px 14px",
          borderBottom: `1px solid ${theme.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12
        }}
      >
        <span style={labelStyle(theme)}>Internal Monologue</span>
        <span style={{ color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
          {formatTimeLabel(props.entry.ts)}
        </span>
      </summary>
      <div
        style={{
          padding: 14,
          color: theme.text,
          fontFamily: sansFont,
          fontSize: 14,
          lineHeight: 1.7,
          whiteSpace: "pre-wrap"
        }}
      >
        {props.entry.content}
      </div>
    </details>
  )
}

function TransitionBadge(props: { tone: TimelineTone; theme: OpenClawTheme; children: ReactNode }) {
  const accent = toneAccent(props.theme, props.tone)
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 999,
        padding: "4px 9px",
        background: `${accent}22`,
        color: accent,
        border: `1px solid ${accent}55`,
        fontFamily: monoFont,
        fontSize: 11
      }}
    >
      {props.children}
    </span>
  )
}

export function StateTransitionTimeline(props: {
  transitions: readonly TransitionTimelineEntry[]
  theme?: OpenClawTheme
  emptyMessage?: string
  style?: CSSProperties
}) {
  const theme = props.theme ?? defaultOpenClawTheme
  if (props.transitions.length === 0) {
    return (
      <div style={mergeStyles(baseCard(theme), { padding: 16 }, props.style)}>
        <div style={labelStyle(theme)}>State Transitions</div>
        <div style={{ color: theme.textMuted, marginTop: 8, fontFamily: sansFont }}>
          {props.emptyMessage ?? "No transitions yet."}
        </div>
      </div>
    )
  }

  return (
    <div style={mergeStyles(baseCard(theme), { padding: 16 }, props.style)}>
      <div style={labelStyle(theme)}>State Transitions</div>
      <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
        {props.transitions.map((transition) => {
          const tone = transition.tone ?? "neutral"
          const accent = toneAccent(theme, tone)
          return (
            <div
              key={transition.id}
              style={{
                display: "grid",
                gridTemplateColumns: "18px 1fr",
                gap: 12,
                alignItems: "start"
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  marginTop: 6,
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: accent,
                  boxShadow: `0 0 16px ${accent}`
                }}
              />
              <div
                style={{
                  border: `1px solid ${theme.border}`,
                  borderRadius: 14,
                  padding: 12,
                  background: theme.panelMuted
                }}
              >
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <TransitionBadge tone={tone} theme={theme}>
                    {transition.label}
                  </TransitionBadge>
                  {transition.fromState || transition.toState ? (
                    <span style={{ color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
                      {transition.fromState ?? "state"} {"->"} {transition.toState ?? "state"}
                    </span>
                  ) : null}
                  {transition.agentName ? (
                    <span style={{ color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
                      {transition.agentName}
                    </span>
                  ) : null}
                  <span style={{ color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
                    {formatTimeLabel(transition.ts)}
                  </span>
                </div>
                {transition.detail ? (
                  <div
                    style={{
                      marginTop: 10,
                      color: theme.text,
                      fontFamily: sansFont,
                      fontSize: 14,
                      lineHeight: 1.6
                    }}
                  >
                    {transition.detail}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MessageBubble(props: { entry: Extract<AgentTimelineEntry, { kind: "message" }>; theme: OpenClawTheme }) {
  const accent =
    props.entry.role === "assistant"
      ? props.theme.accent
      : props.entry.role === "user"
        ? props.theme.warning
        : props.theme.textMuted

  return (
    <div
      style={{
        borderRadius: 16,
        border: `1px solid ${accent}55`,
        background: `${accent}12`,
        padding: 14
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={labelStyle(props.theme)}>{props.entry.role}</span>
        {props.entry.agentName ? (
          <span style={{ color: props.theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
            {props.entry.agentName}
          </span>
        ) : null}
        <span style={{ color: props.theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
          {formatTimeLabel(props.entry.ts)}
        </span>
      </div>
      <div
        style={{
          marginTop: 10,
          color: props.theme.text,
          fontFamily: sansFont,
          fontSize: 14,
          lineHeight: 1.7,
          whiteSpace: "pre-wrap"
        }}
      >
        {props.entry.content}
      </div>
    </div>
  )
}

function ToolCard(props: { entry: ToolTimelineEntry; theme: OpenClawTheme }) {
  const accent = toneAccent(
    props.theme,
    props.entry.status === "error" ? "error" : props.entry.status === "completed" ? "success" : "info"
  )
  return (
    <details
      open={props.entry.status !== "completed"}
      style={mergeStyles(baseCard(props.theme), {
        overflow: "hidden",
        background: props.theme.panelMuted
      })}
    >
      <summary
        style={{
          listStyle: "none",
          cursor: "pointer",
          padding: "12px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <TransitionBadge
            tone={props.entry.status === "error" ? "error" : props.entry.status === "completed" ? "success" : "info"}
            theme={props.theme}
          >
            {props.entry.name}
          </TransitionBadge>
          {props.entry.summary ? (
            <span style={{ color: props.theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
              {props.entry.summary}
            </span>
          ) : null}
        </div>
        <span style={{ color: accent, fontFamily: monoFont, fontSize: 11 }}>{props.entry.status}</span>
      </summary>
      <div style={{ padding: 14, borderTop: `1px solid ${props.theme.border}`, display: "grid", gap: 10 }}>
        {props.entry.input ? (
          <pre
            style={{
              margin: 0,
              padding: 12,
              borderRadius: 12,
              background: props.theme.code,
              color: props.theme.text,
              overflowX: "auto",
              fontFamily: monoFont,
              fontSize: 12,
              lineHeight: 1.6
            }}
          >
            {props.entry.input}
          </pre>
        ) : null}
        {props.entry.result ? (
          <pre
            style={{
              margin: 0,
              padding: 12,
              borderRadius: 12,
              background: props.theme.code,
              color: props.theme.textMuted,
              overflowX: "auto",
              fontFamily: monoFont,
              fontSize: 12,
              lineHeight: 1.6
            }}
          >
            {props.entry.result}
          </pre>
        ) : null}
      </div>
    </details>
  )
}

function TransitionCard(props: { entry: TransitionTimelineEntry; theme: OpenClawTheme }) {
  return (
    <div
      style={{
        borderRadius: 16,
        border: `1px solid ${props.theme.border}`,
        background: props.theme.panelMuted,
        padding: 14
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <TransitionBadge tone={props.entry.tone ?? "neutral"} theme={props.theme}>
          {props.entry.label}
        </TransitionBadge>
        {props.entry.fromState || props.entry.toState ? (
          <span style={{ color: props.theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
            {props.entry.fromState ?? "state"} {"->"} {props.entry.toState ?? "state"}
          </span>
        ) : null}
        <span style={{ color: props.theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
          {formatTimeLabel(props.entry.ts)}
        </span>
      </div>
      {props.entry.detail ? (
        <div
          style={{
            marginTop: 10,
            color: props.theme.text,
            fontFamily: sansFont,
            fontSize: 14,
            lineHeight: 1.6
          }}
        >
          {props.entry.detail}
        </div>
      ) : null}
    </div>
  )
}

export function AgentThread(props: {
  agent: AgentConversationLane
  theme?: OpenClawTheme
  emptyMessage?: string
  style?: CSSProperties
}) {
  const theme = props.theme ?? defaultOpenClawTheme

  return (
    <div style={mergeStyles(baseCard(theme), { padding: 16 }, props.style)}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={labelStyle(theme)}>{props.agent.role ?? "Agent"}</div>
          <div style={{ marginTop: 6, color: theme.text, fontFamily: sansFont, fontSize: 24, fontWeight: 700 }}>
            {props.agent.name}
          </div>
        </div>
        <div style={{ display: "grid", justifyItems: "end", gap: 8 }}>
          <StatusPill status={props.agent.status} theme={theme} />
          <div style={{ color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
            {props.agent.activityHint ?? relativeTime(props.agent.updatedAt) ?? "ready"}
          </div>
        </div>
      </div>

      {props.agent.entries.length === 0 ? (
        <div style={{ marginTop: 16, color: theme.textMuted, fontFamily: sansFont }}>
          {props.emptyMessage ?? "No transcript entries available."}
        </div>
      ) : (
        <div style={{ marginTop: 18, display: "grid", gap: 12 }}>
          {props.agent.entries.map((entry) => {
            if (entry.kind === "message") {
              return <MessageBubble key={entry.id} entry={entry} theme={theme} />
            }
            if (entry.kind === "thinking") {
              return <InternalMonologueCard key={entry.id} entry={entry} theme={theme} />
            }
            if (entry.kind === "tool") {
              return <ToolCard key={entry.id} entry={entry} theme={theme} />
            }
            return <TransitionCard key={entry.id} entry={entry} theme={theme} />
          })}
        </div>
      )}
    </div>
  )
}

export function ParallelAgentConsole(props: {
  data: ParallelAgentConsoleData
  selectedAgentId?: string
  onSelectAgent?: (agentId: string) => void
  theme?: OpenClawTheme
  style?: CSSProperties
}) {
  const theme = props.theme ?? defaultOpenClawTheme
  const firstAgentId = props.data.agents[0]?.id
  const [internalSelection, setInternalSelection] = useState<string | undefined>(firstAgentId)
  const selectedAgentId = props.selectedAgentId ?? internalSelection ?? firstAgentId
  const selectedAgent = useMemo(
    () => props.data.agents.find((agent) => agent.id === selectedAgentId) ?? props.data.agents[0],
    [props.data.agents, selectedAgentId]
  )

  return (
    <div
      style={mergeStyles(
        {
          display: "grid",
          gap: 18,
          gridTemplateColumns: "minmax(280px, 340px) minmax(0, 1fr)",
          color: theme.text,
          fontFamily: sansFont
        },
        props.style
      )}
    >
      <div style={mergeStyles(baseCard(theme), { padding: 16, display: "grid", gap: 12, alignContent: "start" })}>
        <div style={labelStyle(theme)}>Parallel Agents</div>
        {props.data.agents.map((agent) => {
          const accent = statusAccent(theme, agent.status)
          const selected = agent.id === selectedAgent?.id
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => {
                setInternalSelection(agent.id)
                props.onSelectAgent?.(agent.id)
              }}
              style={{
                textAlign: "left",
                borderRadius: 16,
                border: `1px solid ${selected ? `${accent}88` : theme.border}`,
                background: selected ? `${accent}16` : theme.panelMuted,
                padding: 14,
                color: theme.text,
                cursor: "pointer"
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>{agent.name}</div>
                  <div style={{ marginTop: 4, color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
                    {agent.role ?? "agent"}
                    {agent.model ? ` | ${agent.model}` : ""}
                  </div>
                </div>
                <StatusPill status={agent.status} theme={theme} />
              </div>
              <div style={{ marginTop: 10, color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
                {agent.activityHint ?? relativeTime(agent.updatedAt) ?? "no recent updates"}
              </div>
              {agent.issueLabel ? (
                <div style={{ marginTop: 8, color: theme.accent, fontFamily: monoFont, fontSize: 11 }}>
                  {agent.issueLabel}
                </div>
              ) : null}
            </button>
          )
        })}
      </div>

      <div style={{ display: "grid", gap: 18 }}>
        {selectedAgent ? <AgentThread agent={selectedAgent} theme={theme} /> : null}
        <StateTransitionTimeline transitions={props.data.transitions} theme={theme} />
      </div>
    </div>
  )
}
