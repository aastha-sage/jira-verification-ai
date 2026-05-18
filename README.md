# Jira Verify

A GitHub Actions workflow that automatically verifies PR code changes against Jira ticket acceptance criteria using AI (GitHub Models / GPT-4.1). It posts a structured verification report as a PR comment.

## How it works

| Trigger | How to use |
|---------|------------|
| **Auto** | Open or reopen a PR — the workflow extracts Jira ticket IDs from the branch name, PR title, or PR body and runs verification automatically. |
| **Comment** | Post `/verify PROJ-123` (or `/verify PROJ-123,PROJ-456`) as a PR comment to trigger verification on demand. |
| **Manual dispatch** | Run the workflow from the Actions tab with a comma-separated list of ticket IDs to generate a structured requirements document. |

---

## Setup

### 1. Copy files into your repository

Place the files at these exact paths:

```
.github/
  workflows/
    jira-verify.yml      ← the workflow file
  scripts/
    verify.js            ← the script
    package.json         ← dependencies
```

### 2. Configure GitHub Secrets

Go to **Settings → Secrets and variables → Actions** in your repository and add the following secrets:

| Secret | Required | Description |
|--------|----------|-------------|
| `JIRA_BASE_URL` | ✅ Yes | Your Jira instance URL, e.g. `[https://jira.sage.com/]` |
| `JIRA_API_TOKEN` | ✅ Yes | A Jira Personal Access Token (PAT). Generate one in Jira under **Profile → Personal Access Tokens**. |
| `JIRA_EMAIL` | ✅ Yes | The email address of the Jira account that owns the PAT |
| `JIRA_PROJECT_PREFIXES` | ✅ Yes | Pipe-separated list of your Jira project key prefixes, e.g. `PROJ1\|PROJ2` |
| `JIRA_AC_FIELD` | ❌ Optional | Custom Jira field ID for Acceptance Criteria, e.g. `customfield_10016`. Falls back to parsing the description if not set. |

> `GITHUB_TOKEN` is provided automatically by GitHub Actions — no action needed.

### 3. Enable GitHub Models access

The workflow calls the **GitHub Models API** (`models.inference.ai.azure.com`) using the built-in `GITHUB_TOKEN`. This requires your repository to have access to GitHub Models (available on GitHub Team and Enterprise plans, and via the GitHub Models beta for public repositories).

### 4. Ensure PR comment permissions

The workflow writes comments back to PRs. Confirm that **Actions → General → Workflow permissions** in your repository settings is set to **Read and write permissions**, or that the workflow's explicit permissions (already declared in the YAML) are allowed.

---

## Usage

### Auto-verification on PR open

Include a Jira ticket ID anywhere in your branch name, PR title, or PR body:

- Branch name: `feature/PROJ-123-add-login`
- PR title: `[PROJ-123] Add login page`
- PR body: `Closes PROJ-123`

When the PR is opened or reopened, the workflow automatically identifies all matching ticket IDs (based on `JIRA_PROJECT_PREFIXES`) and posts a verification report.

### On-demand via PR comment

Post a comment on any open PR:

```
/verify PROJ-123
```

To verify against multiple tickets:

```
/verify PROJ-123,PROJ-456
```

### Generate requirements document

1. Go to **Actions → Jira Verify → Run workflow**.
2. Enter one or more comma-separated ticket IDs, e.g. `PROJ-123,PROJ-456`.
3. The workflow logs a structured requirements document derived from the tickets and their linked issues.

---

## Verification report structure

The comment posted to the PR includes:

- **Overall verdict** — Pass / Partial / Fail with a one-line summary
- **Per-ticket AC table** — each acceptance criterion mapped to a status (✅ Met / 〰️ Partial / ○ Not met / 🔍 Unverifiable) with file and line evidence
- **Gaps & Blockers** — items that must be fixed before merge
- **Risks & Concerns** — correct changes that carry risk
- **Actionable Suggestions** — concrete, code-level improvement notes
- **Requires Runtime Verification** — criteria that cannot be confirmed from the diff alone

---

## Requirements

- **Node.js 20** (handled automatically by the workflow via `actions/setup-node`)
- **Jira Cloud** (uses Jira REST API v2)
- GitHub repository with access to **GitHub Models**

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@octokit/rest` | ^20.1.1 | GitHub API — read PR diffs, post comments |
| `axios` | 1.16.0 | HTTP client for Jira API and GitHub Models API |

---

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| Workflow skips auto-verification | `JIRA_PROJECT_PREFIXES` secret is not set, or no matching ticket ID found in branch/title/body |
| `Jira authentication failed` | `JIRA_API_TOKEN` or `JIRA_EMAIL` is incorrect |
| `No permission to view TICKET-N` | The Jira service account does not have access to that project |
| `HTTP 401` from GitHub Models | GitHub Models is not enabled for this repository or plan |
| Comment not posted | Workflow permissions are set to read-only — change to read and write in repository settings |
