# Operator-pinned verifier definition text

An unavailable execution image must continue to fail verification and Doctor.
Operators can separately supply historical top-level command text to native
design review through an explicit `verificationDefinitionArchive` policy field:

```json
{
  "verificationDefinitionArchive": {
    "path": "/operator/definitions.json",
    "sha256": "<sha256 of the exact manifest bytes>"
  }
}
```

This optional field requires a Docker verification sandbox. The canonical,
absolute archive path must remain outside the candidate repository. Unix file
ownership checks require a regular single-link file owned by the service user or
root, without group/world write permissions. Symlinks, changed files, malformed
UTF-8, oversized files and digest mismatches fail closed. The whole manifest is
limited to 2 MiB and each command definition to 32 KiB.

The manifest has this shape; `commands` must contain every normalized standing
verification rule, including rules outside the current candidate path selection:

```json
{
  "schemaVersion": 1,
  "image": "sha256:<exact configured image ID>",
  "sourceContextId": "<64 lowercase hex characters identifying the historical source context>",
  "executionAvailable": false,
  "coverage": "top-level-only",
  "helperClosure": "unverified",
  "commands": [
    {
      "ruleId": "<explicit rule ID or native derived rule ID>",
      "command": {
        "id": "<explicit rule ID, omitted for a derived ID>",
        "argv": ["/opt/checks/example"],
        "cwd": ".",
        "timeoutSeconds": 60
      },
      "definition": {
        "path": "/opt/checks/example",
        "content": "#!/bin/sh\nexec example-check\n",
        "sha256": "<sha256 of the exact UTF-8 content>"
      }
    }
  ]
}
```

Command bindings include ordered argv/path conditions, cwd, timeouts and optional
output limits. Missing, extra, duplicate or mismatched rules invalidate the
entire archive. Definition hashes and unchanged runtime redaction are checked
before any text is supplied. Manifest content never selects additional files,
helper reads, commands or execution. An invalid configured archive supplies
incomplete context with a fixed diagnostic; it never silently falls back to the
live image reader. Without the policy field, existing behavior is unchanged.

Every returned definition includes its archive digest and historical source ID,
with explicit top-level-only coverage, unverified helper closure and no execution
availability. Complete text does not prove transitive helper coverage, acceptance
criteria, successful checks, image equivalence or readiness. Reviewers must still
assess the planned coverage and require further evidence when needed.

The pointer and digest participate in the native policy digest. Adopting or
replacing an archive therefore requires the existing operator policy review and
capability refresh/rebind gates; retain prior measurements and receipts. A source
context ID is an attribution, not a signature or independent provenance proof.
This feature does not restore an image, authorize policy adoption, replay blocked
workflows, approve design criteria, or alter verification/Doctor execution gates.
