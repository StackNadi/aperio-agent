---
plan name: enhance-feature
plan description: PR review enhancements
plan status: done
---

## Idea
Enhance the PR review bot with two features: (1) Add suggested code fixes in a dropdown format using HTML details/summary tags, and (2) Enable the bot to reply to user comments on reviews from collaborators/PR owners.

## Implementation
- Update AI response format to include 'suggestion' field with code fix
- Update Zod schema in ai-client to validate suggestion field
- Update formatReviewComment to include <details> dropdown with suggested fix
- Update AI prompt to ask for code suggestions when reporting issues
- Implement review reply handler for pull_request_review_comment events
- Add user filtering - only reply to collaborators and PR owners
- Add AI comment analysis to determine response type (answer/clarify/acknowledge/skip)
- Add rate limiting and idempotency for replies
- Test suggestion feature with webhook
- Test reply feature with PR comments

## Required Specs
<!-- SPECS_START -->
- review-reply-spec
- review-bot-spec
- ts-coding-standard
- comment-standard
<!-- SPECS_END -->