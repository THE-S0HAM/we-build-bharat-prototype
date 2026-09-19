# CommunityOps Data Model

## DynamoDB Table Design

CommunityOps uses two DynamoDB tables:

1. **Main Table** (`CommunityOps-Main-{Stage}`) — all operational entities
2. **Audit Table** (`CommunityOps-Audit-{Stage}`) — immutable audit log

Both use on-demand billing (pay-per-request) for MVP cost efficiency.

## Main Table Schema

### Key Structure

| Key | Pattern | Example |
|-----|---------|---------|
| PK | `{organizationId}` | `ORG-wemakedev` |
| SK | `{entityType}#{entityId}` | `EVENT#EVT-devcon-2026` |
| GSI1PK | `{orgId}#{eventId}` or `{orgId}#EVENTS` | `ORG-wemakedev#EVT-devcon-2026` |
| GSI1SK | `{type}#{status}#{timestamp}` or `EMAIL#{email}` | `SPEAKER#CONFIRMED#2026-...` |

### Entity Sort Key Patterns

| Entity | SK Pattern |
|--------|-----------|
| Organization | `ORG#{orgId}` |
| Event | `EVENT#{eventId}` |
| Registration | `EVENT#{eventId}#REG#{regId}` |
| Payment | `EVENT#{eventId}#PAYMENT#{txnId}` |
| Ticket | `EVENT#{eventId}#TICKET#{regId}` |
| CheckIn | `EVENT#{eventId}#CHECKIN#{regId}` |
| Speaker | `EVENT#{eventId}#SPEAKER#{speakerId}` |
| Team | `EVENT#{eventId}#TEAM#{teamId}` |
| Task | `EVENT#{eventId}#TEAM#{teamId}#TASK#{taskId}` |
| Incident | `EVENT#{eventId}#INCIDENT#{incidentId}` |
| Approval | `EVENT#{eventId}#APPROVAL#{approvalId}` |
| RecoveryCase | `EVENT#{eventId}#RECOVERY#{caseId}` |

### Access Patterns

| Pattern | How | Key Used |
|---------|-----|----------|
| Get event by ID | GetItem | PK=orgId, SK=EVENT#{eventId} |
| List events for org | Query SK prefix | PK=orgId, SK begins_with EVENT# |
| Get registration by ID | GetItem | PK=orgId, SK=EVENT#{eid}#REG#{regId} |
| Find registration by email | GSI1 Query | GSI1PK=orgId#eventId, GSI1SK=EMAIL#{email} |
| Find payment by txn ref | GSI1 Query | GSI1PK=orgId#eventId, GSI1SK=TXN#{txnId} |
| List pending approvals | GSI1 Query | GSI1PK=orgId#eventId, GSI1SK begins_with APPROVAL#PENDING |
| List speakers by status | GSI1 Query | GSI1PK=orgId#eventId, GSI1SK begins_with SPEAKER#{status} |
| List tasks by status | GSI1 Query | GSI1PK=orgId#eventId, GSI1SK begins_with TASK#{status} |

## Audit Table Schema

| Key | Pattern |
|-----|---------|
| PK | `{organizationId}` |
| SK | `AUDIT#{timestamp}#{auditId}` |
| GSI1PK | `{orgId}#{eventId}` |
| GSI1SK | `{action}#{timestamp}` |

### Design Decisions

**Why single-table per bounded context (not per entity)?**
Event operations data is tightly correlated — a registration lookup often needs the event context, a check-in needs the registration and ticket. Keeping related entities in one table allows us to fetch related data in fewer queries.

**Why not full single-table?**
Audit events are write-heavy and read-infrequent. Separating them prevents audit write volume from affecting operational query performance.

**Why on-demand billing?**
MVP/hackathon usage is unpredictable. On-demand avoids capacity planning and over-provisioning costs.
