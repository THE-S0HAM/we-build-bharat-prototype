#!/usr/bin/env bash
# Deploy OrbitOps to AWS
# Usage: ./scripts/deploy.sh --stage dev [--seed]

set -euo pipefail

STAGE="${1:-dev}"
SEED=false
REGION="${AWS_REGION:-ap-south-1}"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --stage) STAGE="$2"; shift 2 ;;
        --seed) SEED=true; shift ;;
        --region) REGION="$2"; shift 2 ;;
        *) shift ;;
    esac
done

echo "=== OrbitOps Deployment ==="
echo "Stage: $STAGE"
echo "Region: $REGION"
echo ""

# Validate prerequisites
command -v aws >/dev/null 2>&1 || { echo "Error: AWS CLI not found"; exit 1; }
command -v sam >/dev/null 2>&1 || { echo "Error: SAM CLI not found"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "Error: Python 3 not found"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Error: Node.js not found"; exit 1; }

# Validate AWS credentials
echo "Checking AWS credentials..."
aws sts get-caller-identity --region "$REGION" > /dev/null || { echo "Error: Invalid AWS credentials"; exit 1; }

# Install Python dependencies
echo "Installing Python dependencies..."
pip install -r requirements.txt -q 2>/dev/null || pip install -e ".[dev]" -q

# Run tests
echo "Running tests..."
PYTHONPATH=. python -m pytest tests/unit/ -q --tb=short

# Build SAM application
echo "Building SAM application..."
sam build --region "$REGION"

# Deploy
echo "Deploying to AWS..."
sam deploy \
    --stack-name "orbitops-${STAGE}" \
    --region "$REGION" \
    --parameter-overrides "Stage=${STAGE}" \
    --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
    --no-confirm-changeset \
    --no-fail-on-empty-changeset \
    --resolve-s3

# Get outputs
echo ""
echo "=== Deployment Outputs ==="
aws cloudformation describe-stacks \
    --stack-name "orbitops-${STAGE}" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[*].[OutputKey,OutputValue]" \
    --output table

# Seed demo data if requested
if [ "$SEED" = true ]; then
    TABLE_NAME=$(aws cloudformation describe-stacks \
        --stack-name "orbitops-${STAGE}" \
        --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='MainTableName'].OutputValue" \
        --output text)

    echo ""
    echo "Seeding demo data to $TABLE_NAME..."
    PYTHONPATH=. python scripts/seed-demo.py --table "$TABLE_NAME" --region "$REGION"
fi

echo ""
echo "=== Deployment Complete ==="
