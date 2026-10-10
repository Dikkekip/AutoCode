# Error recovery

Classify a failure before proposing another attempt:

- **retry** only for a transient timeout, lock, network error, or rate limit;
- **diagnose** when the cause is unclear or verification failed;
- **fallback** when the primary tool or approach repeatedly fails;
- **escalate** only for missing authority, credentials, destructive ambiguity,
  product decisions, or exhausted evidence-backed repair;
- **degrade** only when an explicitly partial outcome remains truthful.

Never silently repeat an attempt. A repeated failure fingerprint requires a new
causal hypothesis or escalation. Do not describe partial failure as success.
Normal coding failures do not require operator confirmation, and one blocked
workflow must not stop unrelated work.
