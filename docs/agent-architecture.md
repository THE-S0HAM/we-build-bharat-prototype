# Agent Architecture

## Overview

CommunityOps uses a multi-layer agent system built on Strands Agents SDK with Amazon Bedrock. The architecture separates deterministic operations (lookups, verification, ticket generation) from AI reasoning (intent understanding, recommendation, natural language).

## Agent Hierarchy

```
Supervisor Agent
    │
    ├── CheckInOps Agent
    │       └── Tools: registration_lookup, payment_lookup, verify_registration, generate_ticket, complete_checkin
    │
    ├── SpeakerOps Agent
    │       └── Tools: speaker_lookup, send_communication, schedule_followup
    │
    ├── TeamOps Agent
    │       └── Tools: task_create, task_update, dependency_check, deadline_monitor
    │
    ├── AttendeeOps Agent
    │       └── Tools: attendee_lookup, missing_info_scan, communication_send
    │
    └── IncidentOps Agent
            └── Tools: incident_analyze, backup_search, session_reschedule
```

## Supervisor Agent

The Supervisor understands operational intent from user messages, routes to the appropriate specialist, and coordinates multi-step work. It decides when human approval is needed based on Cedar policy evaluation.

## Tool Design Principles

1. **Narrow and typed** — each tool does one thing with explicit inputs/outputs
2. **Read-only where possible** — most tools are lookups; mutations go through handlers
3. **Tenant-scoped** — every tool requires `organization_id`
4. **Error-aware** — tools return structured error information, never throw unhandled exceptions
5. **Auditable** — consequential tool invocations create audit events

## Agent Loop

```
Observe (receive user intent or event trigger)
    │
    ▼
Retrieve (use tools to gather operational facts)
    │
    ▼
Reason (analyze facts, identify next action)
    │
    ▼
Policy Check (evaluate Cedar policy)
    │
    ▼
    ├── LOW_RISK → Execute directly
    ├── MEDIUM_RISK → Execute + log
    └── HIGH_RISK → Request human approval
                        │
                        ▼
                  Approval Center
                   │         │
               Approve    Decline
                   │
                   ▼
                Execute
                   │
                   ▼
                Verify (confirm action completed)
                   │
                   ▼
                Audit (create audit event)
                   │
                   ▼
                Re-evaluate (check if more work needed)
```

## What Agents Do vs. Don't Do

### Agents DO:
- Understand operational intent from natural language
- Select tools and interpret results
- Prepare recommendations with evidence
- Draft communications
- Identify operational risks
- Summarize operational state

### Agents DO NOT:
- Determine whether a registration exists (use tool)
- Verify payment status (use tool)
- Create registrations from thin air
- Bypass policy checks
- Execute HIGH_RISK actions without approval
- Access databases directly
- Run arbitrary code

## Error Recovery

Agents handle failures gracefully:
- **Missing data**: State what's unknown, ask for clarification
- **Ambiguous results**: Present candidates, request disambiguation
- **External service unavailable**: Create retry-eligible case, don't claim "not found"
- **Tool failure**: Log error, attempt alternative tool or escalate
- **Approval timeout**: Escalate to next level
