# codex-account-switcher

Manage multiple OpenAI Codex accounts by swapping authentication tokens.

⚠️ **Sensitive:** This skill reads and writes `~/.codex/auth.json` and `~/.codex/accounts/*.json` (authentication tokens).

## ClawHub

Published on [ClawHub](https://clawhub.com/skills/codex-account-switcher).

## Usage

See [SKILL.md](SKILL.md) for full documentation.

```bash
./codex-accounts.py list          # List saved accounts
./codex-accounts.py add           # Add a new account (interactive)
./codex-accounts.py use <name>    # Switch to an account
./codex-accounts.py auto          # Switch to account with best quota
```

## Documentation

- [SKILL.md](SKILL.md) — agent-facing reference (commands, behavior, limitations)
- [SETUP.md](SETUP.md) — prerequisites, configuration, and setup instructions
- [ClawHub](https://www.clawhub.com/skills/codex-account-switcher) — install via ClawHub registry

## License

MIT
