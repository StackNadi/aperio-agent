# Spec: review-reply-spec

Scope: feature

# Review Reply Spec

Scope: feature

## Overview

When a user comments on a PR review (specifically collaborators or PR owners), the bot should detect the comment, analyze it with AI, and post a reply if appropriate.

## Core Requirements

### 1. Event Detection

**Webhook Events to Subscribe:**
- `pull_request_review_comment` — When someone comments on a review
- `issue_comment` — When someone comments on the PR itself (not inline)

**Payload to Extract:**
- `comment.id` — Comment ID for replying
- `comment.user.login` — Who commented
- `comment.body` — Comment content
- `comment.in_reply_to_id` — Parent comment ID (if replying to existing thread)
- `pull_request.number` — PR number
- `repository.owner.login` — Repo owner
- `repository.name` — Repo name

### 2. User Filtering

**Only respond to:**
- PR author (owner of the PR)
- Repository collaborators
- Repository owners

**Skip:**
- Bot comments (including own comments)
- Anonymous users
- Users without write access

**Check via GitHub API:**
```
GET /repos/{owner}/{repo}/collaborators/{username}
```
Returns 204 if user is collaborator, 404 if not.

### 3. Comment Analysis

**AI should determine:**
- Is this a question about the review?
- Is this a request for clarification?
- Is this a "thank you" or acknowledgment?
- Is this a disagreement with the review?
- Is this spam or irrelevant?

**Response Types:**
- `answer` — Answer the question
- `clarify` — Provide more details
- `acknowledge` — Thank or acknowledge
- `skip` — Don't respond (spam, irrelevant, already answered)

### 4. Reply Format

**Reply Structure:**
```markdown
{response}

---
🤖 _This is an automated response from Aperio PR Review Bot_
```

**Tone:**
- Professional and helpful
- Acknowledge the user's input
- Provide actionable information
- Don't be defensive if user disagrees

### 5. Threading

**Reply to inline comments:**
```
POST /repos/{owner}/{repo}/pulls/{pr_number}/comments/{comment_id}/replies
```

**Reply to PR comments:**
```
POST /repos/{owner}/{repo}/issues/{issue_number}/comments
```
With `in_reply_to` field if replying to specific comment.

### 6. Rate Limiting

- Max 5 replies per PR per hour
- Don't reply to own comments
- Don't reply to comments older than 24 hours
- Debounce: wait 30 seconds before replying (user might be typing more)

### 7. Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REPLY_ENABLED` | No | `true` | Enable/disable reply feature |
| `REPLY_MAX_PER_PR` | No | `5` | Max replies per PR per hour |
| `REPLY_DELAY_SECONDS` | No | `30` | Delay before replying |
| `REPLY_SKIP_BOTS` | No | `true` | Skip bot comments |
| `REPLY_ONLY_COLLABORATORS` | No | `true` | Only reply to collaborators |

### 8. Error Handling

- If AI fails to generate reply, log and skip
- If reply fails (422, 403), log and skip
- Never reply to own comments (prevent loops)
- Never reply to comments that are already replies (prevent nesting)

### 9. Idempotency

- Track replied comment IDs in Redis with TTL (24 hours)
- Skip if already replied to this comment
- Use `comment_id` as key: `reply:{comment_id}`