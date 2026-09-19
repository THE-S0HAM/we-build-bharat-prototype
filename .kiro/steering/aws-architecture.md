---
inclusion: auto
name: AWS Architecture Guidelines
description: Guidelines for AWS service usage, SAM templates, Lambda handlers, DynamoDB table design, and infrastructure decisions in CommunityOps
---

# AWS Architecture Guidelines

## Service Map
| Concern | AWS Service |
|---------|------------|
| Identity | Cognito |
| API | API Gateway + Lambda |
| Operational DB | DynamoDB |
| Object storage | S3 |
| Events | EventBridge |
| Workflows | Step Functions |
| Agent models | Bedrock |
| Knowledge/RAG | Bedrock Knowledge Bases (future) / S3 + retrieval abstraction |
| Policy | Cedar (application-level) |
| Email | SES |
| Secrets | Secrets Manager |
| Observability | CloudWatch |
| IaC | SAM + CloudFormation |

## DynamoDB Design
- Use single-table design per bounded context where access patterns align
- Partition key: organizationId or composite key
- Sort key: entity-specific (eventId#entityId, etc.)
- GSIs based on actual query patterns — document each one
- On-demand billing for hackathon/MVP
- Enforce tenant isolation: every query MUST include organizationId

## Lambda Guidelines
- One handler per API operation (no monolithic router Lambdas)
- Python 3.12 runtime
- Powertools for structured logging, tracing
- Environment variables for configuration
- Secrets Manager for credentials
- Max 15 min timeout for workflow Lambdas, 30s for API Lambdas
- Return structured JSON responses with consistent error format

## SAM Template
- Use AWS::Serverless transform
- Parameters for Stage (dev/staging/prod)
- Globals for common Lambda configuration
- Outputs for API URL, Cognito details, resource ARNs

## Do NOT
- Give agents unrestricted DynamoDB/S3/IAM access
- Use Lambda-to-Lambda chaining where Step Functions fits better
- Add AWS services without documenting their purpose
- Use provisioned capacity in MVP
