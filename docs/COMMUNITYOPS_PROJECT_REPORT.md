# CommunityOps Project Report

## 1. Executive Summary

CommunityOps is an AI-powered operations layer for community and event leaders. It coordinates repetitive work across speakers, teams, attendees, incidents, approvals, budgets, check-in, and audit history while keeping consequential decisions under human control. The hackathon system is deployed on AWS and combines deterministic transactional services with a typed Amazon Bedrock tool loop.

## 2. Problem Statement

Event operations are continuous. Organizers repeatedly chase speaker responses, redistribute volunteer work, find missing attendee information, handle incidents, recover tickets, reconcile references, obtain decisions, and reconstruct what happened. Disconnected tools increase cognitive load at exactly the moments when teams are busiest.

## 3. Target Users

Direct users are community leaders, event organizers, volunteer/team leads, speaker coordinators, and registration/check-in leads. Indirect users include speakers, attendees, volunteers, sponsors, and venue/logistics teams.

## 4. Why Registration Tools Are Not the Entire Problem

Registration records who plans to attend. It does not continuously coordinate readiness, speaker silence, team blockers, incident decisions, event-day exceptions, or accountable follow-through. CommunityOps focuses on this operational layer rather than creating another ticket marketplace or event builder.

## 5. CommunityOps Solution

CommunityOps follows: **Detect → Understand → Retrieve context → Plan → Check policy → Act when authorized → Await approval when required → Verify → Audit → Re-evaluate.** Deterministic APIs and data establish facts; the Agent explains and acts only through typed tools.

## 6. Functional Architecture

The Command Center prioritizes attention. Domain views expose SpeakerOps, TeamOps, AttendeeOps, IncidentOps, Check-In, Approvals, Budget, Agent, and Audit. All use shared authentication, organization/event context, reviewed error states, and backend-authoritative mutations.

## 7. Technical Architecture

A React/Vite SPA is hosted through CloudFront and private S3. Cognito issues ID tokens. API Gateway authorizes protected routes and invokes Python 3.12 Lambdas. DynamoDB stores organization-scoped operational records; S3 stores ticket PDFs. Bedrock powers the Agent, Step Functions coordinates long-running workflows, and EventBridge receives domain events. SAM/CloudFormation defines the deployment.

## 8. Complete Technology Stack

- React 19, TypeScript 5.7, Vite 6, React Router 7, Vitest and Testing Library
- Python 3.12, Pydantic, boto3, AWS Lambda Powertools
- Amazon Cognito, API Gateway, Lambda, DynamoDB, S3, EventBridge, Step Functions, Bedrock, CloudFront
- Amazon Nova Pro through the Bedrock Converse API
- Shared typed tool registry with Strands-compatible factories
- Cedar policy files plus tested Python runtime enforcement
- AWS SAM and CloudFormation

## 9. Agent Architecture

The deployed runtime is a framework-neutral Bedrock Converse tool-use loop. It loads role-filtered definitions from a shared registry, invokes bounded tools, feeds verified tool results back to the model, and returns concise evidence. Strands Agent factories consume the same registry, preventing duplicate tool definitions. The UI never exposes chain-of-thought, system prompts, model internals, or token usage.

## 10. Tool Architecture

Tools use snake_case names, strict schemas, validated inputs, principal/event scope, policy metadata, approval requirements, and audit outcomes. Read tools establish facts; mutation tools execute only within the caller’s authority. Unknown actions fail closed as high risk.

## 11. Human Approval Model

High-consequence actions are prepared rather than silently executed. The intended flow is **Agent → policy → approval → authorized execution → verification → audit**. Approval records preserve risk, evidence, affected resources, projections, actor, decision, and notes. The frontend distinguishes “prepared” from “performed.”

## 12. Security Architecture

Cognito protects API routes except the deliberately public, throttled `/demo/session`. Backend handlers resolve principal, authorize organization/scope, enforce role and policy, execute, then audit. IAM roles are service-specific. Ticket buckets are private and encrypted. User-facing errors omit stack traces and internals.

## 13. Tenant Isolation

`PK = organization_id` is the primary DynamoDB isolation boundary. Cognito groups prefixed `ORG-` establish membership; `LEADER` and `TEAM_MEMBER` establish role. URL or frontend values cannot widen membership. Team membership in DynamoDB is authoritative for team/event scope. A live cross-organization request using the restricted demo token returned 403.

## 14. Check-In Architecture

Check-In is deterministic: **Search → Verify → Recover/Reconcile → Complete**. Verification checks registration existence, event, status, payment, cancellation, refund, and eligibility. Ambiguity requires human selection. Recovery creates an encrypted private PDF and HMAC-signed QR data. Completion and ticket recovery are idempotent. The live flow verified search, seven checks, recovery, completion, replay, and QR verification.

## 15. Incident Architecture

IncidentOps separates list, detail, discussion, linked task creation, generic safe updates, and dedicated resolve/reopen endpoints. Terminal transitions are locked in the frontend to prevent duplicate requests and are followed by authoritative list/detail refreshes. `RESOLVED`, `CLOSED`, and `REJECTED` are closed states; unsupported `OPEN` is not exposed.

## 16. Workflow Architecture

Step Functions definitions coordinate speaker follow-up and incident response. High/critical incident paths prepare recommendations and wait for a task-token approval; lower-risk paths can auto-resolve. A live incident execution completed Lambda stages and reached the human approval wait. EventBridge custom-bus ingestion was verified, but no rule currently targets these workflows.

## 17. Data Model Overview

The main table uses organization partition keys and event/user-prefixed sort keys. `entity_type` distinguishes records whose prefixes overlap. GSIs support event/type, lifecycle, status, deadline, and membership access patterns. Financial values are integer rupees. The separate audit table records chronological operational events.

## 18. AWS Services

- **Cognito:** authentication, organization and role groups
- **API Gateway:** REST surface and Cognito authorizer
- **Lambda:** domain, check-in, Agent, and workflow handlers
- **DynamoDB:** operational and audit state
- **S3:** private frontend origin and encrypted ticket artifacts
- **CloudFront:** SPA delivery
- **Bedrock:** Nova Pro reasoning and tool-use loop
- **Step Functions:** human-aware workflows
- **EventBridge:** custom domain-event bus
- **SAM/CloudFormation:** reproducible infrastructure

## 19. Frontend Architecture

The Front_end-v1 visual language remains the UI baseline: light theme, calm hierarchy, responsive navigation, cards, tables, drawers, forms, and progressive disclosure. Shared primitives implement skeleton, empty, error, status, risk, timeline, table, focus-trapped drawer, and event switching behavior. Strict TypeScript mirrors API contracts.

## 20. Backend Architecture

One Lambda handler owns each API concern rather than a monolithic router. Shared modules provide principal resolution, tenancy, policy, repositories, validation, aggregation, health, budget arithmetic, audit, notifications, and typed Agent tools. Deterministic health/brief and financial values are computed server-side.

## 21. Deployment Architecture

The `CommunityOps` stack is deployed in `ap-south-1`. Bedrock inference runs in `us-east-1` using `amazon.nova-pro-v1:0`. CloudFront serves a private S3 origin; the SPA calls API Gateway and Cognito. NoEcho stack parameters preserve demo and QR secrets. The deployed public URL is `https://communityops.sohamdeshmukh.me`.

## 22. Testing Strategy

Backend tests cover domain, authorization, policy parity, deterministic health/budget behavior, tools, handlers, and workflows. Frontend tests cover API scope, authentication, navigation, operational pages, approvals, check-in edge cases, incident locking, accessibility, safe rendering, and responsive shell behavior. Live checks exercise deployed services rather than mocks.

## 23. Local Validation Results

The final application validation produced 565 passing frontend tests across 59 files, 25/25 targeted Agent/Incident regressions, passing TypeScript and lint checks, 31 token-clean CSS files, a successful production build, and a clean diff check. Backend behavior was unchanged by the frontend integration. Hours saved were not measured during the hackathon.

## 24. Live AWS Verification

Live evidence included CloudFormation `UPDATE_COMPLETE`; current frontend delivery; CORS preflight; restricted demo Cognito session; authenticated and unauthenticated API behavior; Command Center/health/attention/brief; operational reads; tenant isolation; Check-In/QR/idempotency; encrypted private ticket PDF; DynamoDB tables/GSIs; Agent capabilities/activity/conversation; EventBridge ingestion; and a Step Functions incident execution reaching approval.

## 25. Problems Encountered

Key issues were branch-safe frontend/backend integration, Cognito and tenant context, misleading Agent failure outcomes, duplicate incident lifecycle requests, CORS preflight authorization, legacy/inference-profile Bedrock compatibility, scoped Lambda model permissions, Marketplace model availability, deployment profile boundaries, NoEcho parameter preservation, and stale synthetic check-in identifiers.

## 26. How Problems Were Solved

The frontend was transplanted in an isolated worktree and reconciled through typed contracts. Fail-closed session/organization handling replaced permissive assumptions. Agent failures now state unknown mutation outcome. Incident transitions use synchronous locks and authoritative refresh. API Gateway OPTIONS was detached from the default authorizer. The unavailable provider model was replaced with live-tested AWS-native Nova Pro, with resource-scoped IAM.

## 27. Cost Optimization Decisions

The design uses on-demand DynamoDB, Lambda, API Gateway, managed identity, S3, and CloudFront rather than continuously running servers. Health/brief aggregation is shared, event-wide task retrieval avoids request fan-out, and Agent tools are invoked only when needed. Exact production cost and cost savings were not measured during the hackathon.

## 28. Hackathon Learning

This was the project’s first end-to-end Kiro experience. It covered ideation, architecture, implementation, tests, refactoring, deployment, and live debugging. Steering and hooks improved consistency and reduced repeated instructions. Official AWS documentation and live errors directly changed CORS, Cognito, Bedrock, IAM, and deployment decisions.

## 29. Impact Model

The AWS Student Builder Group footprint described in the brief spans 977+ universities across 63+ countries, illustrating the distributed ecosystem this solution targets—not measured adoption. The defensible future metric is **hours saved per event × events supported × organizers using CommunityOps**. Actual production users and time savings were not measured during the hackathon.

## 30. Limitations

- Leader-only approval decisions were not live-rehearsed with a leader identity.
- Leader-only incident resolve/reopen was not live-rehearsed.
- EventBridge accepted a live event, but no EventBridge rule currently targets the Step Functions workflows.
- Production time/cost savings were not measured during the hackathon.

## 31. Future Work

Add measured organizer-time analytics, complete live leader rehearsals, wire reviewed EventBridge rules to workflow starts, strengthen observability, and evaluate production onboarding and recovery procedures. Future work should preserve deterministic truth and approval boundaries.

## 32. Demo Flow

A concise demo follows: **Login → Command Center → Agent → Approval boundary → IncidentOps → Check-In → Audit**. The narrative should show an organizer seeing attention, CommunityOps using real tools, a consequential action pausing, an attendee recovering access, and the audit trail proving what occurred.

## 33. Hackathon Judging Alignment

- **Idea & Impact:** solves continuous community operations rather than only registration.
- **Built on AWS:** deployed serverless architecture across the AWS services listed above.
- **Learning:** authentic iteration with Kiro, official documentation, and live runtime feedback.
- **Execution:** operational frontend, tested backend, and exercised AWS paths.
- **Demo:** one clear story demonstrates the problem, bounded automation, human authority, and evidence.
