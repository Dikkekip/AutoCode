# Customization checklist

After installing the control plane into a project repo:

1. Update `.openclaw/state/bootstrap/categories.json`
   - Replace generic lanes with real lane ownership for that codebase.
   - Set category/model preferences that match the repo.

2. Update `.openclaw/state/bootstrap/manager_state.json`
   - Replace generic manager personas with real owners.
   - Replace starter goals/projects with your actual roadmap.
   - Tune prompt patterns for your architecture.

3. Update `.openclaw/state/bootstrap/queue.json`
   - Disable or clear the starter queue items if they do not fit.
   - Set `activeLanes`, `activeCategories`, and concurrency limits.

4. Update `.openclaw/state/bootstrap/notification_config.json`
   - Set the notification channel/target or environment variable policy.

5. Update `.openclaw/state/bootstrap/promotion_policy.json`
   - Set the real GitHub repo slug and release behavior.

6. Use the installed dispatcher runtime
   - Job specs declare schedules and entry agents; the dispatcher selects behavior by job ID.
   - Run a job with `./scripts/openclaw-dispatcher.sh director job <job-id> --project <project>`.
   - These compatibility templates do not configure native Workboard automations. Use `dispatcher native install-automations` for native projects.

7. Keep runtime state out of git
   - `.openclaw/state/current/` should stay mutable and ignored.
   - Commit only prompts, job specs, bootstrap seed state, and documentation.
