# Paperclip Preflight check publication

`flama-delivery-ctl publish-check` converts controller-signed preflight evidence
into the required GitHub `Paperclip Preflight` check for the exact head SHA.
Only the matching company Delivery Controller may run the non-dry-run command.

Plan without requesting an identity or contacting GitHub:

```bash
flama-delivery-ctl publish-check \
  --dry-run \
  --input /protected/evidence/publish-check.json
```

The controller executes publication through `infisical run` so the short-lived
GitHub App installation token enters only the process environment as
`FLAMA_GITHUB_APP_INSTALLATION_TOKEN`. Never place that value in the input,
command line, file, log, artifact, or summary.

Before creating a check, the command requires:

- an in-scope, mutable, non-fork, non-archived repository;
- the owner-matched Delivery Controller and GitHub App slug;
- exactly one successful `buildable` result followed by one successful
  `affected` result;
- a canonical payload digest matching the controller evidence;
- a GitHub App installation token scoped to exactly the target repository;
- GitHub API version `2026-03-10` and `checks:write` authority.

Repeated delivery IDs reuse an identical existing app-authored check. A
conflicting digest, SHA, app identity, or duplicate fails closed. The command
does not retry publication and never reads or prints a GitHub error body.

The GitHub App and Infisical identity are configured in Phase 3. Until then,
only dry-run is operationally authorized. GitHub documents that check runs use
the Checks API and require Checks write permission; installation tokens are
short-lived and can be repository/permission scoped:

- <https://docs.github.com/en/rest/checks/runs>
- <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation>
