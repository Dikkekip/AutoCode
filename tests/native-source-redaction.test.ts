import { describe, expect, it } from "vitest"
import { redactNativeSourceText } from "../packages/core-runtime/src/native/source-redaction.js"

describe("recovery source redaction", () => {
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
