import { describe, expect, it } from "vitest"
import { redactNativeSourceText } from "../packages/core-runtime/src/native/source-redaction.js"

describe("member references that resemble command JWTs", () => {
  it.each([
    "+        execution.recovery.inspectedTaskCount = 3;",
    "+        execution.recovery.outcomes = [execution.recovery.outcomes[0]];",
    "+        const item = { ...execution.recovery.outcomes[0] };",
    "+        {execution.recovery.outcomes.map((result) => result.taskId)}",
    "__SOURCE_MEMBER_DOT_0__ execution.recovery.countsByOutcome = {};"
  ])("preserves source reference %s", (source) => {
    expect(redactNativeSourceText(source)).toBe(source)
  })
  it.each([
    'const token = "abcdefgh.ijklmnop.qrstuvwx";',
    "// abcdefgh.ijklmnop.qrstuvwx",
    "/* abcdefgh.ijklmnop.qrstuvwx */",
    "const token = eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.abcdefghijklmnopqrst;",
    'execution.recovery.outcomes = []; API_KEY="credential123";',
    "execution.recovery.ghp_abcdefghijklmnopqrstuvwxyz012345"
  ])("retains credential filtering: %s", (source) => {
    const redacted = redactNativeSourceText(source)
    expect(redacted).not.toBe(source)
    expect(redacted).not.toContain("abcdefgh.ijklmnop.qrstuvwx")
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.abcdefghijklmnopqrst")
    expect(redacted).not.toContain("credential123")
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345")
  })
})

describe("keyboard comparisons in committed diffs", () => {
  it.each([
    "@@ -4,6 +4,14 @@ type TimelineKeyboardShortcutsProps = {",
    "+ <KeyboardShortcutHint keyLabel={keyLabel} ariaLabel={ariaLabel} ctrl={ctrl} />",
    '+ <AudibleKey keyLabel="←" ariaLabel="Left arrow" />',
    '+ <AudibleKey keyLabel="Page Up" ariaLabel="Page Up" />',
    '+ <AudibleKey keyLabel="Page Down" ariaLabel="Page Down" />'
  ])("preserves bounded keyboard legend source: %s", (source) => {
    expect(redactNativeSourceText(source)).toBe(source)
    expect(redactNativeSourceText(`${source}\n+ API_KEY="credential123"`)).not.toContain("credential123")
  })
  it.each([
    '+ <AudibleKey keyLabel="credential123" />',
    '+ <AudibleKey keyLabel="Enter" API_KEY="credential123" />',
    '+ <AudibleKey keyLabel="Page Up"',
    '@@ -4,6 +4,14 @@ type KeyboardProps = "credential123"',
    "+ <KeyboardShortcutHint keyLabel={credentials.secret} />"
  ])("keeps credential masking around keyboard legend source: %s", (source) => {
    expect(redactNativeSourceText(source)).not.toBe(source)
  })
  it.each([
    "enter",
    "done",
    "go",
    "next",
    "previous",
    "search",
    "send"
  ])("preserves the standard enterKeyHint value %s in a diff attribute", (value) => {
    const source = `+    enterKeyHint="${value}"`
    expect(redactNativeSourceText(source)).toBe(source)
    expect(redactNativeSourceText(`${source}\n+ API_KEY="credential123"`)).not.toContain("credential123")
  })
  it.each([
    "←",
    "→",
    "↑",
    "↓",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    "Enter",
    "O",
    "A",
    "R",
    "[",
    "]",
    "Escape",
    "?",
    "/"
  ])("preserves a complete keyboard hint component with label %s", (label) => {
    const source = `+ <KeyboardShortcutHint keyLabel="${label}" ariaLabel="Keyboard shortcut" />`
    expect(redactNativeSourceText(source)).toBe(source)
    expect(redactNativeSourceText(`${source}\n+ API_KEY="credential123"`)).not.toContain("credential123")
  })
  it.each([
    '+ enterKeyHint="credential123"',
    '+ <KeyboardShortcutHint keyLabel="credential123" />',
    '+ <OtherComponent keyLabel="Enter" />',
    '+ <KeyboardShortcutHint keyLabel="Enter"',
    '+ // enterKeyHint="done"',
    "+ const sample = 'enterKeyHint=\"done\"';",
    '+ <KeyboardShortcutHint keyLabel="Enter" API_KEY="credential123" />'
  ])("retains credential filtering for unsupported keyboard attributes: %s", (source) => {
    expect(redactNativeSourceText(source)).not.toBe(source)
    expect(redactNativeSourceText(source)).not.toContain("credential123")
  })
  it.each([
    "       if (event.key === 'Escape') {",
    '+ if (event.key === "ArrowRight") focusNext();',
    '- if (e.key == "Enter") submit();'
  ])("preserves keyboard logic: %s", (source) => {
    expect(redactNativeSourceText(source)).toBe(source)
  })
  it.each([
    'event.key = "credential123"',
    '// event.key === "Escape"; API_KEY="credential123"',
    'if (event.key === "Escape") API_KEY="credential123"',
    'const sample = "event.key=credential123"'
  ])("still filters credentials: %s", (source) => {
    expect(redactNativeSourceText(source)).not.toContain("credential123")
  })
  it("does not exempt arbitrary key comparisons", () => {
    const source = 'event.key === "arbitrary-value"'
    expect(redactNativeSourceText(source)).not.toBe(source)
  })
  it("preserves a JSX keyboard handler while still filtering credentials in its body", () => {
    const source = [
      "+ <Dialog",
      "+   aria-labelledby={confirmingClear ? titleId + '-clear' : titleId}",
      "+   onKeyDown={(event) => {",
      "+     if (confirmingClear && event.key === 'Escape') {",
      "+       event.preventDefault();",
      "+     }",
      "+   }}",
      "+ />"
    ].join("\n")
    expect(redactNativeSourceText(source)).toBe(source)
    expect(redactNativeSourceText(`${source}\n+ API_KEY="credential123"`)).not.toContain("credential123")
    expect(redactNativeSourceText('<Dialog onKeyDown="credential123" />')).not.toContain("credential123")
  })
  it("keeps added keyboard code after an unmatched removed-line quote", () => {
    const source = [
      "- const stale = 'old",
      "+ <Dialog",
      "+   onKeyDown={(event) => {",
      "+     if (event.key === 'Escape') event.preventDefault();",
      "+   }}",
      "+ />"
    ].join("\n")
    expect(redactNativeSourceText(source)).toBe(source)
  })
  it("preserves a typed keyboard callback declaration in a committed diff", () => {
    const source = "+ const onKeyDown = (event: KeyboardEvent) => {"
    expect(redactNativeSourceText(source)).toBe(source)
    expect(redactNativeSourceText(`${source}\n+ API_KEY="credential123"`)).not.toContain("credential123")
    expect(redactNativeSourceText('const onKeyDown = "credential123"')).not.toContain("credential123")
  })
  it("preserves a typed handleKeyDown callback and bounded keyboard-name comparisons", () => {
    const source = [
      "+ const handleKeyDown = (event: KeyboardEvent) => {",
      "+   expect(items[key === 'End' || key === 'ArrowUp' ? items.length - 1 : key === 'Home' ? 0 : index]);"
    ].join("\n")
    expect(redactNativeSourceText(source)).toBe(source)
    expect(redactNativeSourceText(`${source}\n+ API_KEY="credential123"`)).not.toContain("credential123")
    expect(redactNativeSourceText('+ key === "credential123"')).not.toContain("credential123")
    expect(redactNativeSourceText('const handleKeyDown = "credential123"')).not.toContain("credential123")
  })
  it("preserves the fixed IME keyCode comparison without exposing keyCode credentials", () => {
    const source = "+ if (event.key === 'Enter' && event.keyCode === 229) event.preventDefault();"
    expect(redactNativeSourceText(source)).toBe(source)
    expect(redactNativeSourceText(`${source}\n+ API_KEY="credential123"`)).not.toContain("credential123")
    expect(redactNativeSourceText('event.keyCode === "credential123"')).not.toContain("credential123")
  })
})

describe("identifier comparisons in committed diffs", () => {
  it("preserves a storage key comparison without exposing adjacent credentials", () => {
    const line =
      "+ expect(removeItem.mock.calls.filter(([key]) => key === RECENT_NOTIFICATIONS_STORAGE_KEY)).toHaveLength(1);"
    expect(redactNativeSourceText(line)).toBe(line)
    expect(redactNativeSourceText(`${line}\n+ API_KEY="credential123"`)).not.toContain("credential123")
    expect(redactNativeSourceText("+ key = credential123")).not.toBe("+ key = credential123")
    expect(redactNativeSourceText('+ key === "credential123"')).not.toContain("credential123")
  })
})

describe("structural key derivations in committed diffs", () => {
  it("preserves the complete intake review derivation and synthetic JSX matter fixture", () => {
    const source = [
      "     const key = pauseKey(state);",
      "     const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '-');",
      "+    const reasonKey = JSON.stringify([key, state.revision]);",
      "+    const reviewKey = JSON.stringify([key, state.revision, state.rejectedAttemptCount]);",
      '+    rerender(<IngestionIntakePausePanel {...props} actingKey="matter:MATTER-002:document" />);'
    ].join("\n")
    expect(redactNativeSourceText(source)).toBe(source)
  })

  it.each([
    "const key = credential123;",
    "const key = tokenKey(credential123);",
    "const reasonKey = JSON.stringify([key, credential123]);",
    'const safeKey = "credential123";',
    'const reviewKey = JSON.stringify([key, "credential123"]);',
    '<Panel {...props} actingKey="credential123" />',
    '<Panel {...props} actingKey="matter:MATTER-002:credential123" />'
  ])("keeps credential masking for unsupported key values: %s", (source) => {
    expect(redactNativeSourceText(source)).not.toContain("credential123")
  })

  it("does not shield a quoted fixture outside a complete JSX opening tag", () => {
    const source = "const sample = '<Panel {...props} actingKey=\"matter:MATTER-002:document\" />'"
    expect(redactNativeSourceText(source)).not.toBe(source)
  })
})

describe("recovery source redaction", () => {
  it("preserves a complete JSX reference when a diff hunk omits its opening tag", () => {
    const source = "                                         key={workflow.path}"
    expect(redactNativeSourceText(source)).toBe(source)
    expect(redactNativeSourceText("+   key={workflow.path}")).toBe("+   key={workflow.path}")
    expect(redactNativeSourceText(`${source}\n+ API_KEY="credential123"`)).not.toContain("credential123")
    expect(redactNativeSourceText('+ key={"credential123"}')).not.toContain("credential123")
    expect(redactNativeSourceText("+ key={ghp_abcdefghijklmnopqrstuvwxyz012345}")).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz012345"
    )
  })
  it.each([
    "<option key={tag.tag_id} value={tag.tag_id}>",
    "<Item key={item.id} />",
    "<option disabled key={tag.tag_id}>",
    "<div>__SOURCE_ATTRIBUTE_0__<Item key={item.id}/></div>"
  ])("preserves only safe JSX references: %s", (source) => {
    expect(redactNativeSourceText(source)).toBe(source)
  })
  it.each([
    "KEY=credential123",
    "APIKEY=credential123",
    'API_KEY="credential123"',
    "key='credential123'",
    'key={"credential123"}',
    "Authorization: Bearer credential123",
    '<Item key={tag.id} password="credential123"/>'
  ])("masks credentials including alongside safe JSX: %s", (source) => {
    expect(redactNativeSourceText(source)).not.toContain("credential123")
    expect(redactNativeSourceText(source)).not.toBe(source)
  })
  it.each([
    "key={tag.tag_id}",
    "KEY={tag.tag_id}",
    '<Item key={tag["tag_id"]}/>',
    "<Item key={getKey()}/>",
    "<Item key={-tag.id}/>",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source under test
    "<Item key={`tag-${tag.id}`}/>"
  ])("retains conservative redaction for unsupported syntax: %s", (source) => {
    expect(redactNativeSourceText(source)).not.toBe(source)
  })
  it.each([
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY"
  ])("masks multiline %s", (kind) => {
    expect(
      redactNativeSourceText(`-----BEGIN ${kind}-----\nprivate-key-material\n-----END ${kind}-----`)
    ).not.toContain("private-key-material")
  })
  it("masks unterminated private-key material", () => {
    expect(redactNativeSourceText("-----BEGIN PRIVATE KEY-----\nprivate-key-material")).not.toContain(
      "private-key-material"
    )
  })
  it("preserves a safe reference while masking a credential identifier value inside it", () => {
    expect(redactNativeSourceText("<Item key={ghp_abcdefghijklmnopqrstuvwxyz012345}/>")).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz012345"
    )
  })
})

it("redacts escaped quoted values and malformed tails without leaking suffixes", () => {
  for (const source of [
    String.raw`API_KEY="prefix\"secret-suffix"`,
    String.raw`password='prefix\'secret-suffix'`,
    String.raw`<Item key={tag.id} password="prefix\"secret-suffix"/>`,
    'API_KEY="unterminated-secret-suffix',
    String.raw`key={"prefix\"secret-suffix"}`
  ]) {
    expect(redactNativeSourceText(source)).not.toContain("secret-suffix")
    expect(redactNativeSourceText(source)).not.toContain("prefix")
  }
})
it("handles a bounded long malformed JSX prefix conservatively", () => {
  const source = "<Item " + "attribute ".repeat(20000) + "key={tag.id} password=credential123>"
  const redacted = redactNativeSourceText(source)
  expect(redacted).not.toContain("credential123")
  expect(redacted).not.toBe(source)
}, 5000)

it.each([
  '<X title=" key={secretLiteral}"/>',
  '<X title={" key={secretLiteral}"}/>',
  'const sample = "<Item key={secretLiteral}/>"',
  "// <Item key={secretLiteral}/>",
  "/* <Item key={secretLiteral}/> */",
  '<X title={{ value: "key={secretLiteral}" }}/>'
])("does not protect key-shaped literal or comment text: %s", (source) => {
  expect(redactNativeSourceText(source)).not.toContain("secretLiteral")
})
it("restores many valid keys in one pass without colliding with source markers", () => {
  const sentinels = Array.from({ length: 1000 }, (_, index) => `__SOURCE_ATTRIBUTE_${index}__`).join(" ")
  const source = `${sentinels}\n${"<Item key={item.id}/>\n".repeat(20000)}`
  expect(redactNativeSourceText(source)).toBe(source)
}, 5000)

describe("complete query factory references", () => {
  const declaration = "const detailKey = reportsQueryKeys.bundle({ bundleId });"
  it.each([
    declaration,
    `+    ${declaration}`,
    `-    ${declaration}`,
    "const detailKey = reportsQueryKeys.bundle({ bundleId, otherId, });"
  ])("preserves structural cache references: %s", (source) => {
    expect(redactNativeSourceText(source)).toBe(source)
  })
  it.each([
    'const detailKey = "credential123";',
    'const detailKey = reportsQueryKeys.bundle({ bundleId: "literal-bundle-id" });',
    "const detailKey = reportsQueryKeys[bundle]({ bundleId });",
    "const detailKey = reportsQueryKeys.bundle({ ...bundleId });",
    "const detailKey = reportsQueryKeys.bundle({ bundleId: nested() });",
    "const detailKey = reportsQueryKeys.bundle({ bundleId })",
    "const detailKey = reportsQueryKeys.bundle({ bundleId };",
    "const detailKey = reportsQueryKeys.bundle({});",
    `// ${declaration}`,
    `/* ${declaration} */`,
    `const sample = '${declaration}'`,
    "const sample = `" + declaration + "`"
  ])("does not exempt literals or unsupported declarations: %s", (source) => {
    expect(redactNativeSourceText(source)).not.toBe(source)
    expect(redactNativeSourceText(source)).not.toContain("credential123")
  })
  it("keeps credential scanning on the RHS and the rest of the line", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz012345"
    for (const source of [
      `${declaration} API_KEY="credential123"`,
      `${declaration} Authorization: Bearer credential123`,
      `const detailKey = reportsQueryKeys.bundle({ ${token} });`,
      `${declaration}\n-----BEGIN PRIVATE KEY-----\ncredential123\n-----END PRIVATE KEY-----`,
      String.raw`${declaration} API_KEY="prefix\"credential123"`,
      `${declaration} API_KEY="credential123`
    ]) {
      const redacted = redactNativeSourceText(source)
      expect(redacted).not.toContain("credential123")
      expect(redacted).not.toContain(token)
      expect(redacted).not.toBe(source)
    }
  })
  it("uses bounded parsing and collision-free constant-count restoration passes", () => {
    const sentinels = Array.from({ length: 1000 }, (_, i) => `__SOURCE_QUERY_REFERENCE_${i}__`).join(" ")
    const valid = `${sentinels}\n${`${declaration}\n`.repeat(20000)}`
    expect(redactNativeSourceText(valid)).toBe(valid)
    const long = `const detailKey = reportsQueryKeys.bundle({ ${"parameter,".repeat(20000)} credential123 });`
    expect(redactNativeSourceText(long)).not.toBe(long)
  }, 5000)
})

describe("structural disclosure keys in committed patches", () => {
  const source = [
    "+  const datasetKey = JSON.stringify({",
    "+    bundleId: bundle.bundle_id,",
    "+    incidents: incidents.map(({ incident_id, title }) => [incident_id, title]),",
    "+    groups: summary.groups.map(({ key, incidentLabels }) => [key, incidentLabels]),",
    "+  });",
    "+  const expandedKeys = disclosure.datasetKey === datasetKey ? disclosure.expandedKeys : [];",
    "     group.key === 'select-incidents' || group.key === 'attach-evidence',",
    '+ <Badge key={`${group.key}-${index}-${label}`} variant="outline">'
  ].join("\n")
  it("preserves serialization, state selection, discriminant unions and JSX reference templates", () => {
    expect(redactNativeSourceText(source)).toBe(source)
  })
  it.each([
    'const datasetKey = JSON.stringify({ value: "credential123" });',
    "const datasetKey = JSON.stringify({ value: credential123 });",
    "const expandedKeys = auth.token === datasetKey ? credential123 : [];",
    "<Badge key={`${credential123}-${index}`} />",
    "<Badge key={`credential123-${index}`} />"
  ])("retains credential masking for %s", (value) => {
    expect(redactNativeSourceText(value)).not.toContain("credential123")
  })
  it("keeps adjacent credentials masked", () => {
    expect(redactNativeSourceText(`${source}\n+ API_KEY="credential123"`)).not.toContain("credential123")
  })
})

describe("mapped queue identities and selected event references", () => {
  const declaration = [
    "const queueKey = JSON.stringify(items.map((item) => [",
    "  getTimelineEventKey(item.event),",
    "  item.reason,",
    "  item.blockers.map((blocker) => [blocker.kind, blocker.label, blocker.reason]),",
    "]));"
  ].join("\n")
  it.each(["", "+", "-"])("preserves complete source references with diff prefix %s", (prefix) => {
    const source = declaration
      .split("\n")
      .map((line) => `${prefix}    ${line}`)
      .concat(`${prefix}    const isSelected = eventKey === selectedEventId`)
      .join("\n")
    expect(redactNativeSourceText(source)).toBe(source)
  })
  it.each([
    declaration.replace("item.reason", '"credential123"'),
    declaration.replace("item.reason", "item.secret"),
    declaration.replace("item.reason", "credential123"),
    declaration.replace("getTimelineEventKey(item.event)", "getCredentialKey(item.event)"),
    declaration.replace("item.reason", "'literal-id'"),
    declaration.replace("item.reason", "readValue(item)"),
    declaration.replace("item.reason", "item.reason || fallback"),
    declaration.replace("item.reason", "item.reason + suffix"),
    declaration.replace("]));", "]))"),
    `// ${declaration.split("\n").join(" ")}`,
    `/* ${declaration} */`,
    "const sample = `" + declaration + "`",
    `const sample = ${JSON.stringify(declaration)}`,
    "const isSelected = eventKey === credential123",
    'const isSelected = eventKey === "credential123"',
    "const isSelected = apiKey === selectedEventId",
    "const isSelected = eventKey === auth.token",
    "// const isSelected = eventKey === selectedEventId",
    'const sample = "const isSelected = eventKey === selectedEventId"'
  ])("does not exempt credentials, literals, comments or unsupported expressions: %s", (source) => {
    expect(redactNativeSourceText(source)).not.toBe(source)
  })
  it("retains adjacent credential masking", () => {
    for (const suffix of [' API_KEY="credential123"', '\nAPI_KEY="credential123"']) {
      expect(redactNativeSourceText(`${declaration}${suffix}`)).not.toContain("credential123")
      expect(redactNativeSourceText(`const isSelected = eventKey === selectedEventId${suffix}`)).not.toContain(
        "credential123"
      )
    }
  })
  it("refuses a mapped declaration beyond the bounded statement limit", () => {
    const source = declaration.replace("item.reason,", "item.reason,".repeat(1000))
    expect(redactNativeSourceText(source)).not.toBe(source)
  })
})
