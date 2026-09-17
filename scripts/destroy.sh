#!/usr/bin/env bash
# Destroy OrbitOps AWS resources
# Usage: ./scripts/destroy.sh --stage dev
#
# WARNING: This deletes the CloudFormation stack and ALL associated resources:
# - DynamoDB tables (Main and Audit) with all data
# - S3 buckets (tickets and knowledge) with all objects
# - Cognito user pool and all users
# - API Gateway
# - Lambda functions
# - EventBridge event bus
# - Step Functions state machines
# - IAM roles
#
# This is NOT reversible. Data will be permanently lost.

set -euo pipefail

STAGE="${1:-dev}"
REGION="${AWS_REGION:-ap-south-1}"

while [[ $# -gt 0 ]]; do
    case $1 in
        --stage) STAGE="$2"; shift 2 ;;
        --region) REGION="$2"; shift 2 ;;
        *) shift ;;
    esac
done

STACK_NAME="orbitops-${STAGE}"

echo "=== OrbitOps Destroy ==="
echo "Stack: $STACK_NAME"
echo "Region: $REGION"
echo ""
echo "WARNING: This will permanently delete ALL resources and data."
read -p "Type 'destroy' to confirm: " CONFIRM

if [ "$CONFIRM" != "destroy" ]; then
    echo "Aborted."
    exit 0
fi

# Empty S3 buckets first (CloudFormation can't delete non-empty buckets)
echo "Emptying S3 buckets..."
TICKET_BUCKET=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='TicketBucketName'].OutputValue" \
    --output text 2>/dev/null || echo "")

if [ -n "$TICKET_BUCKET" ] && [ "$TICKET_BUCKET" != "None" ]; then
    aws s3 rm "s3://${TICKET_BUCKET}" --recursive --region "$REGION" 2>/dev/null || true
fi

KNOWLEDGE_BUCKET="orbitops-knowledge-${STAGE}-$(aws sts get-caller-identity --query Account --output text)"
aws s3 rm "s3://${KNOWLEDGE_BUCKET}" --recursive --region "$REGION" 2>/dev/null || true

# Delete the stack
echo "Deleting CloudFormation stack..."
aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"

echo ""
echo "=== Stack $STACK_NAME destroyed ==="
