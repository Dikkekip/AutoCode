import type { CSSProperties, ReactNode } from "react"
import { StatusPill } from "./components.js"
import { autonomousCompanyDashboardFixture } from "./fixtures.js"
import { defaultOpenClawTheme, type OpenClawTheme, toneAccent } from "./theme.js"
import type {
  ActionTaskItem,
  AdapterQuotaItem,
  AdapterQuotaState,
  AuditTimelineEntry,
  AutonomousCompanyDashboardData,
  BlockedTaskItem,
  CodexJobItem,
  CodexJobStatus,
  DashboardMetric,
  DashboardTone,
  DecisionRecord,
  EvaluationTrendPoint,
  HealthState,
  PersonaScorecard,
  ProjectHealthItem,
  PromotionCandidate,
  PullRequestRecord,
  QueueStatus,
  QueueStatusItem,
  RiskAlert,
  TimelineTone
} from "./types.js"
import { formatTimeLabel } from "./utils.js"

const monoFont = "'Cascadia Code', 'SF Mono', 'Fira Code', 'Menlo', monospace"
const sansFont = "ui-sans-serif, system-ui, sans-serif"

function mergeStyles(...styles: Array<CSSProperties | undefined>): CSSProperties {
  return Object.assign({}, ...styles)
}

function panelStyle(theme: OpenClawTheme): CSSProperties {
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

function headingStyle(theme: OpenClawTheme): CSSProperties {
  return {
    color: theme.text,
    fontFamily: sansFont,
    fontSize: 18,
    fontWeight: 750,
    lineHeight: 1.25,
    margin: 0
  }
}

function dashboardToneAccent(theme: OpenClawTheme, tone: DashboardTone | TimelineTone | undefined): string {
  if (!tone || tone === "neutral") return theme.textMuted
  return toneAccent(theme, tone)
}

function healthTone(health: HealthState): DashboardTone {
  if (health === "healthy") return "success"
  if (health === "watch") return "warn"
  if (health === "degraded") return "warn"
  return "error"
}

function priorityTone(priority: ActionTaskItem["priority"]): DashboardTone {
  if (priority === "critical") return "error"
  if (priority === "high") return "warn"
  if (priority === "medium") return "info"
  return "neutral"
}

function quotaTone(state: AdapterQuotaState): DashboardTone {
  if (state === "green") return "success"
  if (state === "amber") return "warn"
  if (state === "red") return "error"
  return "neutral"
}

function queueTone(status: QueueStatus): DashboardTone {
  if (status === "done") return "success"
  if (status === "blocked") return "error"
  if (status === "review_needed" || status === "promotion_pending") return "warn"
  if (status === "running") return "info"
  return "neutral"
}

function jobStatusTone(status: CodexJobStatus): DashboardTone {
  if (status === "succeeded") return "success"
  if (status === "failed" || status === "blocked") return "error"
  if (status === "review_needed") return "warn"
  if (status === "running" || status === "queued") return "info"
  return "neutral"
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function ProgressBar(props: {
  value: number
  tone?: DashboardTone
  label: string
  theme: OpenClawTheme
  max?: number
}) {
  const max = props.max ?? 100
  const percent = Math.max(0, Math.min(100, Math.round((props.value / max) * 100)))
  const accent = dashboardToneAccent(props.theme, props.tone)
  return (
    <div aria-label={`${props.label}: ${percent}%`} role="img">
      <div
        style={{
          height: 8,
          borderRadius: 999,
          background: props.theme.code,
          border: `1px solid ${props.theme.border}`,
          overflow: "hidden"
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: "100%",
            background: accent
          }}
        />
      </div>
    </div>
  )
}

function ToneBadge(props: { children: ReactNode; tone?: DashboardTone | TimelineTone; theme: OpenClawTheme }) {
  const accent = dashboardToneAccent(props.theme, props.tone)
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 999,
        padding: "4px 9px",
        background: `${accent}22`,
        border: `1px solid ${accent}55`,
        color: accent,
        fontFamily: monoFont,
        fontSize: 11,
        whiteSpace: "nowrap"
      }}
    >
      {props.children}
    </span>
  )
}

export function DashboardSection(props: {
  title: string
  eyebrow?: string | undefined
  children: ReactNode
  theme?: OpenClawTheme
  style?: CSSProperties
}) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <section
      aria-labelledby={`${props.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-heading`}
      style={mergeStyles(panelStyle(theme), { padding: 18, minWidth: 0 }, props.style)}
    >
      <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 14 }}>
        <div>
          {props.eyebrow ? <div style={labelStyle(theme)}>{props.eyebrow}</div> : null}
          <h2 id={`${props.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-heading`} style={headingStyle(theme)}>
            {props.title}
          </h2>
        </div>
      </div>
      <div style={{ marginTop: 16 }}>{props.children}</div>
    </section>
  )
}

export function MetricGrid(props: { metrics: readonly DashboardMetric[]; theme?: OpenClawTheme }) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
      {props.metrics.map((metric) => {
        const accent = dashboardToneAccent(theme, metric.tone)
        return (
          <div
            key={metric.id}
            style={{
              border: `1px solid ${theme.border}`,
              borderRadius: 12,
              padding: 14,
              background: theme.panelMuted,
              minWidth: 0
            }}
          >
            <div style={labelStyle(theme)}>{metric.label}</div>
            <div style={{ marginTop: 8, color: accent, fontFamily: sansFont, fontSize: 26, fontWeight: 800 }}>
              {metric.value}
            </div>
            {metric.detail ? (
              <div
                style={{ marginTop: 6, color: theme.textMuted, fontFamily: sansFont, fontSize: 13, lineHeight: 1.45 }}
              >
                {metric.detail}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export function CompanyOverviewPanel(props: {
  data: AutonomousCompanyDashboardData["overview"]
  theme?: OpenClawTheme
}) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <DashboardSection title="Company Overview" eyebrow="Autonomous company" theme={theme}>
      <div style={{ display: "grid", gap: 16 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
            gap: 16
          }}
        >
          <div>
            <div style={{ color: theme.text, fontFamily: sansFont, fontSize: 30, fontWeight: 800, lineHeight: 1.15 }}>
              {props.data.companyName}
            </div>
            <p
              style={{
                color: theme.textMuted,
                fontFamily: sansFont,
                fontSize: 14,
                lineHeight: 1.65,
                margin: "10px 0 0"
              }}
            >
              {props.data.mission}
            </p>
            <p style={{ color: theme.text, fontFamily: sansFont, fontSize: 14, lineHeight: 1.65, margin: "10px 0 0" }}>
              Decision policy: {props.data.decisionPolicy}
            </p>
          </div>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: 10,
              margin: 0,
              color: theme.text,
              fontFamily: sansFont
            }}
          >
            {[
              ["Mode", props.data.operatingMode],
              ["Active projects", String(props.data.activeProjects)],
              ["Active personas", String(props.data.activePersonas)],
              ["Autonomy", props.data.autonomyLevel],
              ["Last director pass", formatTimeLabel(props.data.lastDirectorPassAt)]
            ].map(([label, value]) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 14 }}>
                <dt style={{ color: theme.textMuted }}>{label}</dt>
                <dd style={{ margin: 0, textAlign: "right" }}>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <MetricGrid metrics={props.data.metrics} theme={theme} />
      </div>
    </DashboardSection>
  )
}

export function ProjectHealthPanel(props: { projects: readonly ProjectHealthItem[]; theme?: OpenClawTheme }) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <DashboardSection title="Project Health" eyebrow="Health scoring" theme={theme}>
      <div style={{ display: "grid", gap: 14 }}>
        {props.projects.map((project) => (
          <article key={project.id} style={{ display: "grid", gap: 8 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap"
              }}
            >
              <div>
                <div style={{ color: theme.text, fontFamily: sansFont, fontSize: 16, fontWeight: 750 }}>
                  {project.name}
                </div>
                <div style={{ marginTop: 3, color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
                  {project.repo} | {project.ownerLane}
                </div>
              </div>
              <ToneBadge tone={healthTone(project.health)} theme={theme}>
                {project.health} {project.score}
              </ToneBadge>
            </div>
            <ProgressBar
              value={project.score}
              tone={healthTone(project.health)}
              label={`${project.name} health`}
              theme={theme}
            />
            <div style={{ color: theme.textMuted, fontFamily: sansFont, fontSize: 13, lineHeight: 1.55 }}>
              {project.summary}
            </div>
            <div style={{ color: theme.text, fontFamily: sansFont, fontSize: 13, lineHeight: 1.55 }}>
              Next: {project.nextAction}
            </div>
          </article>
        ))}
      </div>
    </DashboardSection>
  )
}

export function ActiveLoopsPanel(props: {
  loops: AutonomousCompanyDashboardData["activeLoops"]
  theme?: OpenClawTheme
}) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <DashboardSection title="Active Autonomous Loops" eyebrow="Runtime loops" theme={theme}>
      <div style={{ display: "grid", gap: 12 }}>
        {props.loops.map((loop) => (
          <article key={loop.id} style={{ display: "grid", gap: 8 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                alignItems: "center",
                flexWrap: "wrap"
              }}
            >
              <div>
                <div style={{ color: theme.text, fontFamily: sansFont, fontWeight: 750 }}>{loop.name}</div>
                <div style={{ color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>{loop.ownerPersona}</div>
              </div>
              <StatusPill status={loop.status} theme={theme} />
            </div>
            <div style={{ color: theme.textMuted, fontFamily: sansFont, fontSize: 13, lineHeight: 1.55 }}>
              Step: {loop.currentStep}
            </div>
            <div style={{ color: theme.text, fontFamily: sansFont, fontSize: 13, lineHeight: 1.55 }}>
              Decision: {loop.decision}
            </div>
            <div style={{ color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
              Checkpoint: {loop.nextCheckpoint}
            </div>
          </article>
        ))}
      </div>
    </DashboardSection>
  )
}

export function QueueStatusPanel(props: { queue: readonly QueueStatusItem[]; theme?: OpenClawTheme }) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <DashboardSection title="Queue Status" eyebrow="Admission policy" theme={theme}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 12 }}>
        {props.queue.map((item) => (
          <div key={item.id} style={{ display: "grid", gap: 8 }}>
            <ToneBadge tone={queueTone(item.status)} theme={theme}>
              {item.status}
            </ToneBadge>
            <div style={{ color: theme.text, fontFamily: sansFont, fontSize: 28, fontWeight: 800 }}>{item.count}</div>
            <div style={{ color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>Oldest {item.oldestAge}</div>
            <div style={{ color: theme.textMuted, fontFamily: sansFont, fontSize: 13, lineHeight: 1.45 }}>
              {item.policy}
            </div>
          </div>
        ))}
      </div>
    </DashboardSection>
  )
}

function CompactTable(props: {
  caption: string
  headers: readonly string[]
  rows: readonly ReactNode[][]
  theme: OpenClawTheme
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", color: props.theme.text, fontFamily: sansFont }}>
        <caption style={{ ...labelStyle(props.theme), textAlign: "left", marginBottom: 10 }}>{props.caption}</caption>
        <thead>
          <tr>
            {props.headers.map((header) => (
              <th
                key={header}
                scope="col"
                style={{
                  borderBottom: `1px solid ${props.theme.border}`,
                  color: props.theme.textMuted,
                  fontFamily: monoFont,
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "0 12px 10px 0",
                  textAlign: "left",
                  textTransform: "uppercase",
                  whiteSpace: "nowrap"
                }}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, index) => (
            <tr key={String(index)}>
              {row.map((cell, cellIndex) => (
                <td
                  key={String(cellIndex)}
                  style={{
                    borderBottom: `1px solid ${props.theme.border}`,
                    padding: "12px 12px 12px 0",
                    verticalAlign: "top",
                    fontSize: 13,
                    lineHeight: 1.45
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function RunningCodexJobsPanel(props: { jobs: readonly CodexJobItem[]; theme?: OpenClawTheme }) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <DashboardSection title="Running Codex Jobs" eyebrow="Execution" theme={theme}>
      <CompactTable
        caption="Codex jobs"
        headers={["Task", "Persona", "Model", "Status", "Decision"]}
        rows={props.jobs.map((job) => [
          <span key="task">
            <strong>{job.taskId}</strong>
            <br />
            {job.title}
          </span>,
          job.persona,
          job.model,
          <ToneBadge key="status" tone={jobStatusTone(job.status)} theme={theme}>
            {job.status}
          </ToneBadge>,
          job.decisionSummary
        ])}
        theme={theme}
      />
    </DashboardSection>
  )
}

export function TaskReviewPanel(props: {
  reviewNeededTasks: readonly ActionTaskItem[]
  blockedTasks: readonly BlockedTaskItem[]
  theme?: OpenClawTheme
}) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <DashboardSection title="Review and Blockers" eyebrow="Human or reviewer gates" theme={theme}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 18 }}>
        <div>
          <div style={labelStyle(theme)}>Review-needed tasks</div>
          <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
            {props.reviewNeededTasks.map((task) => (
              <TaskRow key={task.id} task={task} theme={theme} />
            ))}
          </div>
        </div>
        <div>
          <div style={labelStyle(theme)}>Blocked tasks</div>
          <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
            {props.blockedTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                theme={theme}
                extra={`Blocker: ${task.blocker} Escalation: ${task.escalationOwner}`}
              />
            ))}
          </div>
        </div>
      </div>
    </DashboardSection>
  )
}

function TaskRow(props: { task: ActionTaskItem; theme: OpenClawTheme; extra?: string | undefined }) {
  return (
    <article style={{ display: "grid", gap: 7 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ color: props.theme.text, fontFamily: sansFont, fontWeight: 750 }}>{props.task.title}</div>
        <ToneBadge tone={priorityTone(props.task.priority)} theme={props.theme}>
          {props.task.priority}
        </ToneBadge>
      </div>
      <div style={{ color: props.theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
        {props.task.project} | {props.task.ownerPersona}
      </div>
      <div style={{ color: props.theme.textMuted, fontFamily: sansFont, fontSize: 13, lineHeight: 1.5 }}>
        {props.task.reason}
      </div>
      <div style={{ color: props.theme.text, fontFamily: sansFont, fontSize: 13, lineHeight: 1.5 }}>
        Next: {props.task.nextAction}
      </div>
      {props.extra ? (
        <div style={{ color: props.theme.warning, fontFamily: sansFont, fontSize: 13, lineHeight: 1.5 }}>
          {props.extra}
        </div>
      ) : null}
    </article>
  )
}

export function PersonaScorecardsPanel(props: { personas: readonly PersonaScorecard[]; theme?: OpenClawTheme }) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <DashboardSection title="Persona Scorecards" eyebrow="Autonomous operators" theme={theme}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14 }}>
        {props.personas.map((persona) => (
          <article key={persona.id} style={{ display: "grid", gap: 9 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start" }}>
              <div>
                <div style={{ color: theme.text, fontFamily: sansFont, fontWeight: 800 }}>{persona.persona}</div>
                <div style={{ color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>{persona.role}</div>
              </div>
              <StatusPill status={persona.status} theme={theme} />
            </div>
            <ProgressBar
              value={persona.score}
              tone={persona.score >= 85 ? "success" : "warn"}
              label={`${persona.persona} score`}
              theme={theme}
            />
            <div style={{ color: theme.text, fontFamily: sansFont, fontSize: 22, fontWeight: 800 }}>
              {persona.score}
            </div>
            <div style={{ color: theme.textMuted, fontFamily: sansFont, fontSize: 13, lineHeight: 1.5 }}>
              Throughput {persona.throughput} | Review pass {formatPercent(persona.reviewPassRate)} | Decision quality{" "}
              {formatPercent(persona.decisionQuality)}
            </div>
            <div style={{ color: theme.text, fontFamily: sansFont, fontSize: 13, lineHeight: 1.5 }}>
              {persona.currentFocus}
            </div>
          </article>
        ))}
      </div>
    </DashboardSection>
  )
}

export function AdapterQuotaPanel(props: { adapters: readonly AdapterQuotaItem[]; theme?: OpenClawTheme }) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <DashboardSection title="Adapter Quota and Status" eyebrow="Admission controls" theme={theme}>
      <div style={{ display: "grid", gap: 14 }}>
        {props.adapters.map((adapter) => {
          const value =
            adapter.remaining !== null && adapter.limit !== null && adapter.limit > 0 ? adapter.remaining : 0
          const max = adapter.limit ?? 100
          return (
            <article key={adapter.id} style={{ display: "grid", gap: 8 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap"
                }}
              >
                <div>
                  <div style={{ color: theme.text, fontFamily: sansFont, fontWeight: 750 }}>{adapter.adapter}</div>
                  <div style={{ color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>{adapter.lane}</div>
                </div>
                <ToneBadge tone={quotaTone(adapter.state)} theme={theme}>
                  {adapter.state}
                </ToneBadge>
              </div>
              <ProgressBar
                value={value}
                max={max}
                tone={quotaTone(adapter.state)}
                label={`${adapter.adapter} quota`}
                theme={theme}
              />
              <div style={{ color: theme.textMuted, fontFamily: sansFont, fontSize: 13, lineHeight: 1.5 }}>
                {adapter.remaining === null || adapter.limit === null
                  ? "Quota telemetry unavailable."
                  : `${adapter.remaining} of ${adapter.limit} remaining.`}{" "}
                {adapter.policy}
              </div>
            </article>
          )
        })}
      </div>
    </DashboardSection>
  )
}

export function DecisionsPanel(props: { decisions: readonly DecisionRecord[]; theme?: OpenClawTheme }) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <DashboardSection title="Recent Decisions" eyebrow="Rationale and evidence" theme={theme}>
      <div style={{ display: "grid", gap: 14 }}>
        {props.decisions.map((decision) => (
          <article key={decision.id} style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <ToneBadge tone="info" theme={theme}>
                {decision.action}
              </ToneBadge>
              <span style={{ color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
                {decision.actor} | {formatTimeLabel(decision.madeAt)}
              </span>
            </div>
            <div style={{ color: theme.text, fontFamily: sansFont, fontSize: 13, lineHeight: 1.55 }}>
              {decision.rationale}
            </div>
            <div style={{ color: theme.success, fontFamily: sansFont, fontSize: 13, lineHeight: 1.55 }}>
              Outcome: {decision.outcome}
            </div>
            <ul
              style={{
                color: theme.textMuted,
                fontFamily: sansFont,
                fontSize: 13,
                lineHeight: 1.5,
                margin: 0,
                paddingLeft: 18
              }}
            >
              {decision.evidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </DashboardSection>
  )
}

export function RiskAlertsPanel(props: { risks: readonly RiskAlert[]; theme?: OpenClawTheme }) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <DashboardSection title="Risk Alerts" eyebrow="Risk controls" theme={theme}>
      <div style={{ display: "grid", gap: 13 }}>
        {props.risks.map((risk) => (
          <article key={risk.id} style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div style={{ color: theme.text, fontFamily: sansFont, fontWeight: 800 }}>{risk.title}</div>
              <ToneBadge tone={priorityTone(risk.severity)} theme={theme}>
                {risk.severity}
              </ToneBadge>
            </div>
            <div style={{ color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>{risk.project}</div>
            <div style={{ color: theme.textMuted, fontFamily: sansFont, fontSize: 13, lineHeight: 1.5 }}>
              Signal: {risk.signal}
            </div>
            <div style={{ color: theme.text, fontFamily: sansFont, fontSize: 13, lineHeight: 1.5 }}>
              Mitigation: {risk.mitigation}
            </div>
          </article>
        ))}
      </div>
    </DashboardSection>
  )
}

export function PromotionAndPrPanel(props: {
  candidates: readonly PromotionCandidate[]
  pullRequests: readonly PullRequestRecord[]
  theme?: OpenClawTheme
}) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <DashboardSection title="Promotion Candidates and PRs" eyebrow="Release path" theme={theme}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18 }}>
        <CompactTable
          caption="Promotion candidates"
          headers={["Task", "Readiness", "Checks", "Policy"]}
          rows={props.candidates.map((candidate) => [
            <span key="task">
              <strong>{candidate.taskId}</strong>
              <br />
              {candidate.title}
            </span>,
            <span key="readiness">
              {candidate.readiness}%
              <ProgressBar
                value={candidate.readiness}
                tone={candidate.readiness >= 85 ? "success" : "warn"}
                label={`${candidate.taskId} readiness`}
                theme={theme}
              />
            </span>,
            `${candidate.checks} / ${candidate.reviewState}`,
            candidate.mergePolicy
          ])}
          theme={theme}
        />
        <CompactTable
          caption="Created PRs"
          headers={["PR", "State", "Author", "Decision"]}
          rows={props.pullRequests.map((pr) => [
            <a key="pr" href={pr.url} style={{ color: theme.accent }}>
              {pr.title}
            </a>,
            pr.state,
            pr.authorPersona,
            pr.decisionSummary
          ])}
          theme={theme}
        />
      </div>
    </DashboardSection>
  )
}

export function EvaluationTrendsPanel(props: { trends: readonly EvaluationTrendPoint[]; theme?: OpenClawTheme }) {
  const theme = props.theme ?? defaultOpenClawTheme
  const chartHeight = 120
  return (
    <DashboardSection title="Evaluation Trends" eyebrow="Quality signal" theme={theme}>
      <div
        aria-label="Evaluation trend chart"
        role="img"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${props.trends.length}, minmax(36px, 1fr))`,
          gap: 10,
          minHeight: chartHeight + 42,
          alignItems: "end"
        }}
      >
        {props.trends.map((point) => (
          <div key={point.label} style={{ display: "grid", gap: 7, alignItems: "end" }}>
            <div
              style={{
                height: chartHeight,
                display: "grid",
                alignItems: "end",
                borderBottom: `1px solid ${theme.border}`
              }}
            >
              <div
                title={`Pass ${formatPercent(point.passRate)}, coverage ${formatPercent(point.coverage)}, regressions ${point.regressions}`}
                style={{
                  height: `${Math.max(8, Math.round(point.passRate * chartHeight))}px`,
                  background: `linear-gradient(180deg, ${theme.success}, ${theme.accent})`,
                  borderRadius: "8px 8px 0 0"
                }}
              />
            </div>
            <div style={{ color: theme.textMuted, fontFamily: monoFont, fontSize: 11, textAlign: "center" }}>
              {point.label}
            </div>
          </div>
        ))}
      </div>
    </DashboardSection>
  )
}

export function AuditTimelinePanel(props: { entries: readonly AuditTimelineEntry[]; theme?: OpenClawTheme }) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <DashboardSection title="Audit and Event Timeline" eyebrow="Append-only event view" theme={theme}>
      <ol style={{ display: "grid", gap: 14, margin: 0, padding: 0, listStyle: "none" }}>
        {props.entries.map((entry) => {
          const accent = toneAccent(theme, entry.tone)
          return (
            <li key={entry.id} style={{ display: "grid", gridTemplateColumns: "18px minmax(0, 1fr)", gap: 12 }}>
              <span
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
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <ToneBadge tone={entry.tone} theme={theme}>
                    {entry.event}
                  </ToneBadge>
                  <span style={{ color: theme.textMuted, fontFamily: monoFont, fontSize: 11 }}>
                    {entry.actor} | {formatTimeLabel(entry.at)}
                  </span>
                </div>
                <div style={{ marginTop: 7, color: theme.text, fontFamily: sansFont, fontSize: 13, lineHeight: 1.55 }}>
                  {entry.detail}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </DashboardSection>
  )
}

export function AutonomousCompanyDashboard(props: {
  data: AutonomousCompanyDashboardData
  theme?: OpenClawTheme
  style?: CSSProperties
}) {
  const theme = props.theme ?? defaultOpenClawTheme
  return (
    <main
      style={mergeStyles(
        {
          minHeight: "100vh",
          background: theme.background,
          color: theme.text,
          fontFamily: sansFont,
          padding: 24
        },
        props.style
      )}
    >
      <div style={{ display: "grid", gap: 18, maxWidth: 1480, margin: "0 auto" }}>
        <CompanyOverviewPanel data={props.data.overview} theme={theme} />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
            gap: 18
          }}
        >
          <ProjectHealthPanel projects={props.data.projectHealth} theme={theme} />
          <ActiveLoopsPanel loops={props.data.activeLoops} theme={theme} />
        </div>
        <QueueStatusPanel queue={props.data.queueStatus} theme={theme} />
        <RunningCodexJobsPanel jobs={props.data.runningCodexJobs} theme={theme} />
        <TaskReviewPanel
          reviewNeededTasks={props.data.reviewNeededTasks}
          blockedTasks={props.data.blockedTasks}
          theme={theme}
        />
        <PersonaScorecardsPanel personas={props.data.personaScorecards} theme={theme} />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
            gap: 18
          }}
        >
          <AdapterQuotaPanel adapters={props.data.adapterQuotas} theme={theme} />
          <DecisionsPanel decisions={props.data.recentDecisions} theme={theme} />
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
            gap: 18
          }}
        >
          <RiskAlertsPanel risks={props.data.riskAlerts} theme={theme} />
          <PromotionAndPrPanel
            candidates={props.data.promotionCandidates}
            pullRequests={props.data.pullRequests}
            theme={theme}
          />
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
            gap: 18
          }}
        >
          <EvaluationTrendsPanel trends={props.data.evaluationTrends} theme={theme} />
          <AuditTimelinePanel entries={props.data.auditTimeline} theme={theme} />
        </div>
      </div>
    </main>
  )
}

export function AutonomousCompanyDashboardPreview(props: { theme?: OpenClawTheme; style?: CSSProperties }) {
  return (
    <AutonomousCompanyDashboard
      data={autonomousCompanyDashboardFixture}
      {...(props.theme ? { theme: props.theme } : {})}
      {...(props.style ? { style: props.style } : {})}
    />
  )
}
