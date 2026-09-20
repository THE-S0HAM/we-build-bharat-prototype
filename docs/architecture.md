# CommunityOps Architecture

## Overview

CommunityOps is an AI Community Operations Agent built on AWS-native serverless services. It coordinates event operations for community organizers by automating repetitive work while keeping consequential decisions under human control.

## Fundamental Principles

1. **Deterministic systems establish facts** — registration status, payment captures, check-in eligibility are verified through database/API calls, never inferred by AI
2. **AI reasons about facts** — agents analyze operational state and recommend actions
3. **Policies control authority** — Cedar policies define what agents may do at each risk level
4. **Workflows execute process** — Step Functions orchestrate multi-step async operations
5. **Humans approve consequential actions** — HIGH_RISK actions require explicit approval

## Architecture Diagram
<img width="1208" height="1302" alt="image" src="https://github.com/user-attachments/assets/b4158e65-e7dd-4c8c-baf3-cfeda3351bb3" />

All data access is scoped by `organization_id` (DynamoDB partition key). Every query, whether from API handler, agent tool, or workflow step, includes the organization ID. Cedar policies additionally enforce that principals can only access resources within their organization.
