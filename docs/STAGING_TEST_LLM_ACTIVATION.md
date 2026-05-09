# Staging Test: v3.1 LLM Audit Narrative Activation

Validates that the v3.1 engagement-narrative section appears in cloud audit
reports when `LLM_PROVIDER` and friends are set at the server level.

---

## Prereqs

- Anthropic API key (from console.anthropic.com) with at least $5 remaining budget,
  OR an OpenRouter API key (from openrouter.ai) — see **Alternative: OpenRouter** below.
- Coolify access to the Prism deployment (admin panel, env var editor)
- Test fixture: `test/fixtures/scorm12-violations.zip` from the repo root
  (download from the repo or `scp` to your machine — it's ~12 KB)

---

## Alternative: OpenRouter

OpenRouter is a gateway that routes requests to the same Claude models using Anthropic's own
infrastructure. Reasons to prefer it: consolidated billing across providers, organizational
policy, or easier provider failover without rotating Anthropic keys.

Tradeoff: OpenRouter charges Anthropic's published rates plus a ~5% gateway markup. Functionally
identical to direct access — same models, same context windows, same output quality.

To use OpenRouter instead of a direct Anthropic key, set these env vars in place of the
Anthropic ones:

```
LLM_PROVIDER=openrouter
LLM_KEY_FROM_ENV=OPENROUTER_API_KEY
OPENROUTER_API_KEY=sk-or-v1-...
LLM_MODEL=claude-haiku-4-5
```

> `LLM_MODEL` accepts the bare alias (`claude-haiku-4-5`); the engine auto-prefixes it to
> `anthropic/claude-haiku-4-5` when the provider is `openrouter`. No code change needed.

Optional: set `OPENROUTER_REFERER` to a URL identifying your deployment. Defaults to
`https://prism.skill-loop.com` if unset (the engine sets this).

The rest of this runbook — configure, verify in cloud, verify cost, rollback — applies
identically. Substitute OpenRouter's usage dashboard (openrouter.ai/activity) for the
Anthropic console in the **Verify Cost** step. Expected per-audit cost is ~5% higher.

---

## Configure

In the Coolify env var editor for **both** the `cloud` and `worker`
containers, add:

```
LLM_PROVIDER=anthropic
LLM_KEY_FROM_ENV=ANTHROPIC_API_KEY
ANTHROPIC_API_KEY=<your-key>
LLM_MODEL=claude-haiku-4-5
```

> `LLM_MODEL` is optional — `claude-haiku-4-5` is the default. Omit to
> accept the default or substitute `claude-sonnet-4-6` for higher quality.

Leave all existing vars (`PRISM_MODE`, `DATABASE_URL`, `SMTP_*`, etc.)
exactly as they are.

**Restart** both the cloud and worker containers after saving. The env vars
are read at process start; a running instance will not pick them up.

---

## Verify in Cloud

1. Open the Prism UI and upload `scorm12-violations.zip`.
2. Wait for the audit to complete (spinner → green).
3. Download or open the HTML report (`report.html`).
4. Look for **"Section 01a — Engagement Narrative"** near the top of the
   report, above the violation table. It should contain three subsections:
   - **Executive Summary** — plain-language overview of the audit findings
   - **Per-Criterion Remediation Guides** — one block per failed criterion
   - **Scope Memo** — estimated consultant hours and prioritization notes
5. Each LLM-generated block should carry a small pill reading:
   **"AI-generated · review before sharing"**

**If the section is absent:**

- Check the worker container logs in Coolify for a line containing
  `narrative skipped` — this means `llmProvider` never reached `writeReports`.
- Verify the env vars are set on the **worker** container (not only cloud).
- Confirm the containers were restarted after the env change.

---

## Verify Cost

Expected spend per audit at default settings:

| Model | Default token budget | Expected cost |
|---|---|---|
| `claude-haiku-4-5` | 30 000 tokens | ~$0.054 |

In the [Anthropic console](https://console.anthropic.com) → Usage, a
successful audit should show a batch of calls totaling ~$0.05–$0.10.
Higher than $0.10 per audit suggests the model is `sonnet` or `opus`;
lower suggests fewer violations (shorter prompts).

---

## Rollback

To disable narrative generation, in Coolify:

- Unset `LLM_PROVIDER` (or set it to an empty string).
- Restart both containers.

Reports will immediately return to the deterministic-only path. No data
is lost — previously generated reports are unaffected.

---

## Known Limitations

- **Only the audit narrative is wired in cloud right now.** The LLM env
  vars activate v3.1 narrative generation only.
- **Assisted-tier rebuild (v4.1)** — `generate-alt-text`, `rewrite-link-text`,
  `generate-form-label` — is CLI-only. Phase 12 / 12.5 brings it to cloud.
- **Transformer judgment (v5.1)** — widget classification in full-tier rebuilds
  — is CLI-only. Same phase dependency.
- **Per-workspace BYO keys** — each tenant supplying their own Anthropic key
  — is deferred to Phase 12.5. Until then all workspaces share the operator's
  key set above.
- The `report.md` download endpoint does **not** forward LLM env vars (only
  `report.html` and `report.json` do). Markdown reports remain deterministic
  until Phase 12.5 wires that endpoint.
