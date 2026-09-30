# Native session-bound tool registration

AutoCode native tools use OpenClaw's version 2 tool factory context and declare
`confinement: "session-bound"`. The host must support this registration contract;
legacy tool declarations remain unclassified by Workboard workspace validation.
The local OpenClaw 2026.9.6 source repair adds the generic contract to the tool
registrar and runtime sandbox authority resolver.

The declaration classifies a trusted broker; normal role tool permissions still
apply. AutoCode derives the role and session from the factory closure and checks
one live assigned Workboard card before each native action. Operator RPC cannot
claim a model identity. The host invocation assertion is propagated through the
native evidence store's asynchronous effect scope and rechecked before writes and
existing guarded effects. Expired invocations and detached descendants cannot
write after the owning call closes. Native lease fencing remains active.

Validate source registration, disabled/retired owners, unknown tools, session
revocation after awaited work, and a real sandboxed Workboard worker before
activation. Preserve the early Workboard subagent completion repair when replacing
the host runtime. Provider availability alone does not prove role eligibility.
