// .github/scripts/verify.js
// Runs inside GitHub Actions — uses GITHUB_TOKEN (Copilot Enterprise) as the LLM

const { Octokit } = require('@octokit/rest')
const axios = require('axios')
const fs = require('fs')

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const REPO_OWNER = process.env.REPO_OWNER
const REPO_NAME = process.env.REPO_NAME
const PR_NUMBER = parseInt(process.env.PR_NUMBER)
const COMMENT_BODY = process.env.COMMENT_BODY ?? ''
const COMMENT_USER = process.env.COMMENT_USER ?? ''
// Comma-separated list of ticket IDs found in the branch/PR title (set by the auto-trigger job)
const AUTO_TICKET_IDS = process.env.AUTO_TICKET_IDS ?? ''

// Set to "true" by the generate-requirements workflow job
const GENERATE_REQUIREMENTS = process.env.GENERATE_REQUIREMENTS === 'true'
// Comma-separated ticket IDs provided via workflow_dispatch input
const TICKET_IDS_INPUT = process.env.TICKET_IDS ?? ''

const octokit = new Octokit({ auth: GITHUB_TOKEN })

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractTicketIds(text) {
  const prefixes = process.env.JIRA_PROJECT_PREFIXES ?? 'SCSU|ASAU'
  const matches = text.match(
    new RegExp(`\\b((?:${prefixes})-\\d{1,5})\\b`, 'g')
  )
  return matches ? [...new Set(matches)] : []
}

// ── Jira ─────────────────────────────────────────────────────────────────────

const JIRA_BASE = (process.env.JIRA_BASE_URL ?? '').replace(/\/$/, '')
const JIRA_TOKEN = process.env.JIRA_API_TOKEN ?? ''
const AC_FIELD = process.env.JIRA_AC_FIELD ?? 'description'

function jiraHeaders() {
  return {
    Authorization: `Bearer ${JIRA_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'jira-verify-action/1.0',
  }
}

async function fetchJiraTicket(ticketId) {
  const url = `${JIRA_BASE}/rest/api/2/issue/${ticketId}`

  let data
  try {
    const res = await axios.get(url, { headers: jiraHeaders() })
    data = res.data
  } catch (err) {
    const status = err.response?.status
    if (status === 404) throw new Error(`Ticket ${ticketId} not found in Jira.`)
    if (status === 401)
      throw new Error(
        `Jira authentication failed. Check your JIRA_API_TOKEN secret.`
      )
    if (status === 403)
      throw new Error(
        `No permission to view ${ticketId}. Check the service account's project access.`
      )
    const body = JSON.stringify(err.response?.data ?? '')
    throw new Error(
      `Jira API error (${status ?? 'unknown'}): ${err.message} — ${body}`
    )
  }

  const fields = data.fields

  // Extract acceptance criteria — tries the custom field first, then parses from description
  const acceptanceCriteria =
    extractText(fields[AC_FIELD]) ||
    extractSectionFromDescription(fields.description, 'acceptance criteria') ||
    extractSectionFromDescription(fields.description, 'definition of done') ||
    extractText(fields.description)

  const linkedKeys = (fields.issuelinks ?? []).flatMap((link) => {
    const keys = []
    if (link.inwardIssue?.key) keys.push(link.inwardIssue.key)
    if (link.outwardIssue?.key) keys.push(link.outwardIssue.key)
    return keys
  })

  return {
    key: data.key,
    summary: fields.summary ?? '',
    description: extractText(fields.description),
    acceptanceCriteria,
    status: fields.status?.name ?? 'Unknown',
    assignee: fields.assignee?.displayName ?? null,
    labels: fields.labels ?? [],
    linkedKeys,
  }
}

// Jira uses Atlassian Document Format (ADF) — recursively extract plain text
function extractText(node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (node.type === 'text') return node.text ?? ''
  if (node.content && Array.isArray(node.content)) {
    return node.content
      .map(extractText)
      .join(
        [
          'paragraph',
          'heading',
          'bulletList',
          'listItem',
          'orderedList',
        ].includes(node.type)
          ? '\n'
          : ''
      )
  }
  return ''
}

// Try to extract a named section from the description (e.g. "Acceptance Criteria:")
function extractSectionFromDescription(adf, sectionName) {
  const fullText = extractText(adf)
  const re = new RegExp(
    `${sectionName}[:\\s]*([\\s\\S]+?)(?=\\n[A-Z][^\\n]+:|$)`,
    'i'
  )
  return fullText.match(re)?.[1]?.trim() ?? ''
}

// ── GitHub — PR Diff ─────────────────────────────────────────────────────────

async function getPRDiff() {
  const { data: files } = await octokit.pulls.listFiles({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    pull_number: PR_NUMBER,
    per_page: 100,
  })

  // 8 000-token hard limit (~4 chars/token = 32 000 chars total).
  // Budget: ~1 500 tokens for system-prompt instructions, ~1 000 for ticket content,
  // ~500 for the user message/template, ~2 000 for the response (max_tokens) — leaving
  // ~3 000 tokens (~12 000 chars) for the diff.
  const MAX_CHARS = 12000

  // Always include the full file index so the model knows every file touched
  const fileIndex =
    `### Files changed (${files.length})\n` +
    files
      .map(
        (f, i) =>
          `${i + 1}. \`${f.filename}\` [${f.status}] (+${f.additions} -${
            f.deletions
          })`
      )
      .join('\n') +
    '\n\n---\n\n'

  let diff = fileIndex
  const budgetLeft = () => MAX_CHARS - diff.length

  for (const file of files) {
    const header = `### ${file.filename} [${file.status}] (+${file.additions} -${file.deletions})\n`

    if (!file.patch) {
      const block = header + '_Binary or no diff_\n\n'
      if (budgetLeft() < block.length) break
      diff += block
      continue
    }

    const fullBlock = header + `\`\`\`diff\n${file.patch}\n\`\`\`\n\n`

    if (budgetLeft() >= fullBlock.length) {
      // Fits entirely — include it as-is
      diff += fullBlock
    } else {
      // Partial patch — truncate the patch lines to fill remaining budget
      const overhead =
        header.length + '```diff\n'.length + '\n```\n\n'.length + 60 // reserve for truncation note
      const room = budgetLeft() - overhead
      if (room > 0) {
        const truncatedPatch = file.patch.slice(0, room)
        const truncatedLines = file.patch.length - truncatedPatch.length
        diff +=
          header +
          `\`\`\`diff\n${truncatedPatch}\n\`\`\`\n` +
          `_...patch truncated (${truncatedLines} chars omitted)_\n\n`
      }
      break
    }
  }

  return { diff, fileCount: files.length }
}

// ── GitHub Models API (supports GITHUB_TOKEN / S2S tokens in Actions) ────────────

async function callCopilot(systemPrompt, userMessage) {
  let response
  try {
    response = await axios.post(
      'https://models.inference.ai.azure.com/chat/completions',
      {
        model: 'gpt-4.1',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 2000,
        temperature: 0.2,
      },
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    )
  } catch (err) {
    const status = err.response?.status
    const body = err.response?.data
    // Surface every available detail so the PR comment is actionable
    const detail =
      body?.error?.message ?? // OpenAI-style {error:{message}}
      body?.message ?? // plain {message}
      JSON.stringify(body) ?? // anything else
      err.message
    throw new Error(`HTTP ${status ?? 'unknown'}: ${detail}`)
  }

  return response.data.choices[0].message.content
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(tickets, diff) {
  // Cap per-ticket text to keep the total prompt within the 8 000-token input limit.
  // ~1 000 tokens (~4 000 chars) shared across all tickets is a safe budget.
  const MAX_TICKET_CHARS = Math.floor(4000 / Math.max(tickets.length, 1))
  function truncate(text, max) {
    if (!text || text.length <= max) return text
    return text.slice(0, max) + '\n_…(truncated)_'
  }

  // One block per ticket describing its details and AC for the system prompt
  const ticketSections = tickets
    .map(
      (ticket) =>
        `### Jira Ticket: ${ticket.key}
- **Summary:** ${ticket.summary}
- **Status:** ${ticket.status}${
          ticket.assignee ? `\n- **Assignee:** ${ticket.assignee}` : ''
        }${
          ticket.labels?.length
            ? `\n- **Labels:** ${ticket.labels.join(', ')}`
            : ''
        }

#### Description
${
  truncate(ticket.description?.trim(), MAX_TICKET_CHARS) ||
  '_No description provided._'
}

#### Acceptance Criteria
${
  truncate(ticket.acceptanceCriteria?.trim(), MAX_TICKET_CHARS) ||
  '_No explicit AC field found — acceptance criteria have been inferred from the description above. Flag this in your output._'
}`
    )
    .join('\n\n---\n\n')

  const ticketKeys = tickets.map((t) => t.key).join(', ')

  // Per-ticket table template embedded in the user message
  const perTicketTemplate = tickets
    .map(
      (ticket) =>
        `### [${ticket.key}](${process.env.JIRA_BASE_URL}browse/${ticket.key}): ${ticket.summary}

> **Verdict:** <Pass / Partial / Fail and why>

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | <criterion text, ≤ 12 words> | ✅ Met / 〰️ Partial / ○ Not met / 🔍 Unverifiable | \`filename:line\` — <one-line rationale> |
| … | … | … | … |`
    )
    .join('\n\n')

  return {
    system: `
You are a Senior Engineer performing PR review.
Your sole responsibility is to determine, with precision, whether the code changes in a pull request
fully satisfy the acceptance criteria (AC) defined on the Jira ticket(s).

Each file block contains the unified diff with surrounding context.
Focus on what the diff shows changed, trace imports and function names visible in the patch,
and flag anything that looks incomplete or risky.

## Your evaluation methodology

1. **Parse each AC item individually.** If the AC is free-form text, extract discrete testable
   statements. Number them in the order you find them.
2. **Trace the implementation path** for each AC item:
   - Follow function calls and data flow visible in the diff context
   - Check that error paths and edge cases are handled (null/undefined, empty arrays, network failures)
   - Confirm that any state changes, side effects, or API calls match the AC intent
3. **Map concrete evidence to each AC item.** Quote the specific filename and changed line as evidence.
4. **Classify each item** using exactly one status:
   - ✅ **Met** — the diff clearly and completely addresses this criterion
   - 〰️ **Partial** — the diff addresses part of it but something is missing or ambiguous
   - ○ **Not met** — no relevant change found in the diff
   - 🔍 **Unverifiable** — requires runtime behaviour, environment config, or test execution to confirm
5. **Identify risk.** Flag any changes that could introduce regressions, break contracts, or have
   security/performance implications, even if the AC is met.
6. **Be surgical with suggestions.** Only suggest concrete, actionable code-level changes with exact
   file and line references. Never say "consider refactoring" without specifying exactly what and where.
7. **Do not hallucinate.** If evidence is absent, say so. Do not infer that something "probably works".

## Input context

${ticketSections}

### PR Diff (${diff.split('\n').length} lines, most-changed files first)
${diff}
    `.trim(),

    user: `
Analyse the PR changes against every acceptance criterion for **${ticketKeys}**.

For each ticket and each AC item, trace the actual implementation: check function bodies, follow
imports, verify error handling, and confirm the change does what the criterion requires end-to-end.
Cite specific lines from the diff as evidence.

Produce your report using the exact structure below. Do not omit any section.

---

## 🔎 AC Verification — ${ticketKeys}

> **Overall verdict:** <one concise sentence — Pass / Partial / Fail across all tickets and why>

${perTicketTemplate}

---

### Gaps & Blockers
<!--  Items that MUST be addressed before merge. One bullet per gap.
      Format: **[TICKET-N · AC #N]** <what is missing> — <file:line or area to change>
      Write "None" if all AC items are fully met. -->

### Risks & Concerns
<!--  Changes that are technically correct but carry risk (regressions, edge cases,
      security, performance, contract changes). One bullet per concern.
      Format: **[Risk]** <description> — <file:line>
      Write "None" if no concerns. -->

### 💡 Actionable Suggestions
<!--  Optional improvements: concrete, specific, code-level.
      Format: **[file:line]** <what to change and why>
      Write "None" if nothing to add. -->

### 🔍 Requires Runtime Verification
<!--  AC items or behaviours that cannot be confirmed from the diff alone.
      Write "None" if everything is verifiable statically. -->

### ℹ️ Notes
<!--  Any meta-observations: missing AC field in Jira, unusually large diff,
      test coverage gaps, unreachable code paths noticed, etc.
      Omit this section entirely if nothing to note. -->
    `.trim(),
  }
}

// ── Requirements prompt ───────────────────────────────────────────────────────

function buildRequirementsPrompt(rootTickets, allTickets) {
  const MAX_TICKET_CHARS = Math.floor(6000 / Math.max(allTickets.length, 1))
  function truncate(text, max) {
    if (!text || text.length <= max) return text
    return text.slice(0, max) + '\n_…(truncated)_'
  }

  const ticketSections = allTickets
    .map((ticket) => {
      const isRoot = rootTickets.some((r) => r.key === ticket.key)
      return `### ${isRoot ? '🎯 Primary' : '🔗 Linked'} Ticket: ${ticket.key}
- **Summary:** ${ticket.summary}
- **Status:** ${ticket.status}${ticket.assignee ? `\n- **Assignee:** ${ticket.assignee}` : ''}${
        ticket.labels?.length ? `\n- **Labels:** ${ticket.labels.join(', ')}` : ''
      }

#### Description
${truncate(ticket.description?.trim(), MAX_TICKET_CHARS) || '_No description provided._'}

#### Acceptance Criteria
${truncate(ticket.acceptanceCriteria?.trim(), MAX_TICKET_CHARS) || '_No explicit AC found._'}`
    })
    .join('\n\n---\n\n')

  const rootKeys = rootTickets.map((t) => t.key).join(', ')

  return {
    system: `
You are a Senior Business Analyst and Solutions Architect.
Your task is to synthesise Jira tickets into a clear, structured requirements document.
You will be given one or more primary tickets and any tickets directly linked to them.
Produce a single cohesive requirements list that a development team can use as a definitive source of truth.

Extract ALL discrete requirements — functional and non-functional — from the ticket descriptions,
acceptance criteria, and any implicit constraints visible in the data.
Do not invent requirements that are not supported by the ticket content.

## Input tickets

${ticketSections}
    `.trim(),

    user: `
Based on the Jira tickets provided, generate a comprehensive requirements document for **${rootKeys}**.

Produce your output using the exact structure below:

---

## 📋 Requirements — ${rootKeys}

> **Summary:** <one-paragraph overview of what needs to be built / delivered>

### Functional Requirements

| # | Requirement | Source Ticket | Priority |
|---|-------------|---------------|----------|
| FR-1 | <clear, testable requirement statement> | TICKET-N | Must / Should / Could |
| … | … | … | … |

### Non-Functional Requirements

| # | Requirement | Source Ticket | Priority |
|---|-------------|---------------|----------|
| NFR-1 | <performance, security, accessibility, scalability, etc.> | TICKET-N | Must / Should / Could |
| … | … | … | … |

### Acceptance Criteria Summary

| FR # | Criterion | Notes |
|------|-----------|-------|
| FR-1 | <AC statement derived from ticket> | <caveats or open questions, or "-"> |
| … | … | … |

### Dependencies & Linked Work

| Linked Ticket | Relationship | Impact |
|---------------|--------------|--------|
| [TICKET-N](${JIRA_BASE}/browse/TICKET-N) | blocks / is blocked by / relates to | <one-line impact description> |

### Open Questions

- <Any ambiguities or missing information that need clarification before development begins>
- Write "None" if everything is clear.

### Out of Scope

- <Anything explicitly excluded or deferred based on the ticket content>
- Write "None" if nothing is explicitly out of scope.

---
    `.trim(),
  }
}

// ── Requirements generation (workflow_dispatch) ───────────────────────────────

async function generateRequirements() {
  const prefixes = process.env.JIRA_PROJECT_PREFIXES ?? 'SCSU|ASAU'
  const ticketPattern = new RegExp(`^(?:${prefixes})-\\d{1,5}$`)

  const rootIds = TICKET_IDS_INPUT.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((id) => ticketPattern.test(id))

  if (rootIds.length === 0) {
    console.error(
      `No valid Jira ticket IDs found in input: "${TICKET_IDS_INPUT}"\n` +
        `Expected format: comma-separated IDs matching prefixes (${prefixes}), e.g. SCSU-123,ASAU-456`
    )
    process.exit(1)
  }

  console.log(`Fetching ${rootIds.length} root ticket(s): ${rootIds.join(', ')}`)

  // Fetch root tickets
  let rootTickets
  try {
    rootTickets = await Promise.all(rootIds.map(fetchJiraTicket))
  } catch (err) {
    console.error(`Jira error: ${err.message}`)
    process.exit(1)
  }

  // Collect all unique linked ticket keys (one level deep, filtered to known prefixes)
  const linkedIds = [
    ...new Set(
      rootTickets
        .flatMap((t) => t.linkedKeys)
        .filter((id) => ticketPattern.test(id))
        .filter((id) => !rootIds.includes(id))
    ),
  ]

  console.log(
    linkedIds.length > 0
      ? `Fetching ${linkedIds.length} linked ticket(s): ${linkedIds.join(', ')}`
      : 'No linked tickets found.'
  )

  let linkedTickets = []
  if (linkedIds.length > 0) {
    const results = await Promise.allSettled(linkedIds.map(fetchJiraTicket))
    linkedTickets = results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value)
    const failed = results.filter((r) => r.status === 'rejected')
    if (failed.length > 0) {
      console.warn(
        `Could not fetch ${failed.length} linked ticket(s): ${failed
          .map((r) => r.reason?.message)
          .join('; ')}`
      )
    }
  }

  const allTickets = [...rootTickets, ...linkedTickets]

  console.log(
    `Generating requirements from ${allTickets.length} ticket(s) total…`
  )

  // Call Copilot
  let report
  try {
    const { system, user } = buildRequirementsPrompt(rootTickets, allTickets)
    report = await callCopilot(system, user)
  } catch (err) {
    console.error(`Copilot API error: ${err.message}`)
    process.exit(1)
  }

  // Build footer
  const now = new Date().toUTCString()
  const ticketRefs = rootIds
    .map((id) => `[${id}](${JIRA_BASE}/browse/${id})`)
    .join(', ')
  const footer =
    `\n\n---\n` +
    `<sub>🤖 **jira-verify** · model: <code>gpt-4.1</code> · ` +
    `tickets: ${ticketRefs} · ` +
    `${now}</sub>`

  const fullReport = report + footer

  // Write to GitHub Step Summary (visible in the Actions run UI)
  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (summaryFile) {
    fs.appendFileSync(summaryFile, fullReport + '\n')
    console.log('✅ Requirements written to GitHub Step Summary')
  } else {
    // Local / debug run — print to stdout
    console.log('\n' + fullReport)
  }
}

// ── GitHub — Post Comment ─────────────────────────────────────────────────────

async function postComment(body) {
  await octokit.issues.createComment({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: PR_NUMBER,
    body,
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Route to requirements generation when triggered by workflow_dispatch
  if (GENERATE_REQUIREMENTS) {
    await generateRequirements()
    return
  }

  // 1. Resolve ticket IDs — prefer the auto-detected list injected by the workflow,
  //    otherwise parse them all from the /verify comment body.
  const prefixes = process.env.JIRA_PROJECT_PREFIXES ?? 'SCSU|ASAU|SCOM'
  const ticketPattern = new RegExp(`^(?:${prefixes})-\\d{1,5}$`)

  let rawTickets
  if (AUTO_TICKET_IDS) {
    // Comma-separated list produced by the extract step in the workflow
    rawTickets = AUTO_TICKET_IDS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  } else {
    rawTickets = extractTicketIds(COMMENT_BODY)
  }

  const ticketIds = rawTickets.filter((id) => ticketPattern.test(id))

  if (ticketIds.length === 0) {
    if (AUTO_TICKET_IDS !== '') {
      // Auto-trigger found something that doesn't match a real ticket ID — skip silently.
      console.log(
        `Extracted value "${AUTO_TICKET_IDS}" contains no valid Jira ticket IDs — skipping.`
      )
      process.exit(0)
    }
    if (!COMMENT_USER) {
      // Auto-trigger with nothing extracted at all — skip silently.
      console.log('No Jira tickets found — skipping auto-verification.')
      process.exit(0)
    }
    const prefixList = prefixes.split('|')
    const examples = prefixList.map((p) => `\`/verify ${p}-123\``).join(' or ')
    await postComment(
      `👋 @${COMMENT_USER} — please include a Jira ticket ID in your command, e.g:\n\n` +
        examples
    )
    process.exit(0)
  }

  // 2. Post a "working on it" comment so the user knows it's running
  const ticketLinks = ticketIds
    .map((id) => `**[${id}](${process.env.JIRA_BASE_URL}browse/${id})**`)
    .join(', ')
  await postComment(
    `<!-- jira-verify:in-progress -->\n🔍 Running AC verification for ${ticketLinks} — this usually takes under a minute…`
  )

  // 3. Fetch all Jira tickets in parallel
  let tickets
  try {
    tickets = await Promise.all(ticketIds.map(fetchJiraTicket))
  } catch (err) {
    await postComment(`❌ **Jira error**: ${err.message}`)
    process.exit(1)
  }

  // 4. Fetch PR diff
  let diff, fileCount
  try {
    ;({ diff, fileCount } = await getPRDiff())
  } catch (err) {
    await postComment(`❌ **GitHub error fetching PR diff**: ${err.message}`)
    process.exit(1)
  }

  // 5. Call Copilot with all tickets' AC combined
  let report
  try {
    const { system, user } = buildPrompt(tickets, diff)
    report = await callCopilot(system, user)
  } catch (err) {
    await postComment(
      `❌ **Copilot API error**: ${err.message}\n\n` +
        `<details><summary>Debug info</summary>\n\n` +
        `- Model: \`gpt-4.1\`\n` +
        `- Endpoint: \`https://models.inference.ai.azure.com/chat/completions\`\n` +
        `- Token present: \`${!!GITHUB_TOKEN}\`\n\n` +
        `</details>`
    )
    process.exit(1)
  }

  // 6. Post the verification report
  const now = new Date().toUTCString()
  const ticketRefs = ticketIds
    .map((id) => `[${id}](${process.env.JIRA_BASE_URL}browse/${id})`)
    .join(', ')
  const footer =
    `\n\n---\n` +
    `<sub>🤖 **jira-verify** · model: <code>gpt-4.1</code> · ` +
    `${fileCount} file(s) analysed · ` +
    `${ticketRefs} · ` +
    `${now}</sub>`

  await postComment(report + footer)
  console.log('✅ Verification complete')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
