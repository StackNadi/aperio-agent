---
plan name: production-readiness
plan description: Harden production behavior
plan status: done
---

## Idea
Fix the production-readiness gaps found in the audit: webhook idempotency ordering, reply retry behavior, reply idempotency failure handling, startup environment validation, AI/GitHub request timeouts, health/readiness behavior, reply trigger scoping, AI failure handling, reviewed-with-no-findings markers, Docker base pinning, Redis production assumptions, webhook body size limits, stale README, and critical test coverage.

## Implementation
- Read the created plan and linked repository specs before implementation.
- Fix webhook delivery idempotency so delivery keys are only recorded after successful enqueue or intentional skip, with cleanup on failures.
- Fix reply job retry behavior by rethrowing unexpected worker errors and making reply idempotency recover on terminal failure or successful completion.
- Add strict startup configuration validation for GitHub, AI, Redis, numeric env values, and private key base64 decoding.
- Add request timeouts for AI and GitHub API calls and ensure retry handling remains deterministic.
- Improve health/readiness behavior so production checks can detect Redis/config readiness without breaking simple liveness.
- Constrain reply triggering to explicit bot mentions or Aperio-owned review/comment context to avoid unsolicited replies.
- Make review jobs retry when all AI review attempts fail and add durable marker behavior for reviewed commits with no findings.
- Pin Docker base image to the required Bun 1.3.x tag and document Redis production assumptions.
- Add webhook payload size limiting and update stale README/Docker docs for production behavior.
- Add or update focused tests for the production failure paths, then run lint, typecheck, tests, build, Compose config validation, and Docker builds.

## Required Specs
<!-- SPECS_START -->
- comment-standard
- ts-coding-standard
<!-- SPECS_END -->