# ADR-001: DynamoDB over RDS for Operational Data

## Status
Accepted

## Context
CommunityOps needs a database for operational state: events, registrations, tickets, tasks, speakers, incidents, approvals. The primary access patterns are key-value lookups (get registration by ID, get event by ID) and filtered queries (list pending approvals, list speakers by status).

## Decision
Use Amazon DynamoDB with on-demand billing.

## Rationale
- **Access patterns fit DynamoDB**: most queries are PK+SK lookups or GSI queries, not complex joins
- **Tenant isolation**: organization_id as partition key naturally enforces boundaries
- **Cost**: on-demand billing means zero cost when idle, no capacity planning for hackathon
- **Performance**: single-digit-ms latency for operational lookups (critical for check-in UX)
- **Serverless**: no connection pooling, no VPC, no DB management
- **Scalability**: handles event-day spikes without manual intervention

## Alternatives Considered
- **RDS (PostgreSQL)**: better for complex queries and reporting, but requires VPC, connection management, and provisioned capacity. Adds operational complexity disproportionate to MVP needs.
- **Aurora Serverless v2**: auto-scaling but still requires VPC setup and minimum capacity charges.

## Consequences
- Must design around DynamoDB access patterns (documented in data-model.md)
- Complex analytics require separate read model or export to S3 + Athena
- Single-table design per bounded context keeps related data together
