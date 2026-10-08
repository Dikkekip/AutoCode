# Continuous native operations

Native schedules remain the execution owner. Host maintenance observes the supported
Gateway APIs and never launches a second dispatcher, replays accepted work, or bypasses
verification, independent review, CI or release receipts.

The daily Telegram digest selects native status when a repository has its native policy. It counts Workboard activity separately from deployed workflows,
uses the native queue and pressure diagnostics, and reports unmeasured usage honestly.
A failed native probe fails the digest instead of displaying the retired dispatcher queue.

`scripts/native-autonomy-watch.py` requires `AUTOCODE_BOARD_ID` and
`AUTOCODE_REPOSITORY`, and accepts `OPENCLAW_COMMAND` and `AUTOCODE_WATCH_STATE_DIR`. Preserve its existing state when
upgrading. `--dry-run` previews alerts without sending or changing schedules. Each
operator pause revision produces one alert; technical pauses do not ask for product
approval. The monitor leaves reconciliation to the native schedules.

`scripts/native-autonomy-maintenance.mjs` requires `--openclaw`, `--board` and `--state`.
Without `--apply` it previews a decision and makes no state or control changes. Persistent
Automatic Gateway maintenance requires a single registered native project; multi-project
Gateways need a coordinated drain. Gateway RSS pressure must span ten minutes and at least three observations. CPU load
alone never triggers restart. Running or pending cards, live native leases, operation
journals, and verification memory reservations block restart. Admission is paused with
an expected control revision and execution evidence is checked again. A race returns
control to the native runtime instead of killing accepted work.

After an idle restart, the next timer checks Doctor and resumes only the exact pause
revision owned by maintenance. An intervening operator pause is preserved. State is
written atomically before restart; restart attempts have a one-hour cooldown. Unknown
or missing evidence fails closed. Protect the state directory and use a single service
instance or `flock` to prevent concurrent invocations.

The example user systemd units read `~/.config/autocode-maintenance.env` containing:

```ini
AUTOCODE_FRAMEWORK=/absolute/path/to/autocode
OPENCLAW_COMMAND=/absolute/path/to/openclaw
AUTOCODE_BOARD_ID=your-board
```

Install the example units under `~/.config/systemd/user/`, then run `systemctl --user
daemon-reload` and `systemctl --user enable --now autocode-maintenance.timer`. User
lingering must be enabled for execution after logout. Install only after native Doctor
and framework checks pass. Missing `activeLeases` status on an older framework prevents
maintenance from restarting it; upgrade during an independently confirmed idle window.

Continuous operation still respects quotas, disk space, resource headroom and product
decisions. A timer being enabled is not proof of code shipped: check accepted candidate,
verification, review and deployment evidence.
