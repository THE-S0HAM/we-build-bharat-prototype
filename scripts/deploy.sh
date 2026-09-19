#!/usr/bin/env bash
# Deploy CommunityOps to AWS
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

echo "=== CommunityOps Deployment ==="
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
pip install -e ".[dev]" -q

# Run tests
echo "Running tests..."
PYTHONPATH=. python -m pytest tests/unit/ -q --tb=short

# Every Lambda uses CodeUri: . so that `services`, `tools` and `agents` resolve
# as top-level packages. SAM's Python builder copies the whole CodeUri tree and
# has no exclude mechanism, so the frontend's node_modules (~117 MB) would be
# packaged into every function and push the artifact past Lambda's 250 MB
# unzipped limit. Move it aside for the build and always restore it.
NODE_MODULES="apps/web/node_modules"
NODE_MODULES_ASIDE="$(mktemp -d)/node_modules"
MOVED_NODE_MODULES=false

restore_node_modules() {
    if [ "$MOVED_NODE_MODULES" = true ] && [ -d "$NODE_MODULES_ASIDE" ]; then
        mv "$NODE_MODULES_ASIDE" "$NODE_MODULES"
        MOVED_NODE_MODULES=false
        echo "Restored $NODE_MODULES"
    fi
}
trap restore_node_modules EXIT INT TERM

if [ -d "$NODE_MODULES" ]; then
    echo "Excluding $NODE_MODULES from the Lambda build artifact..."
    mv "$NODE_MODULES" "$NODE_MODULES_ASIDE"
    MOVED_NODE_MODULES=true
fi

# Build SAM application
echo "Building SAM application..."
sam build --region "$REGION"

restore_node_modules

# Deploy
echo "Deploying to AWS..."
sam deploy \
    --stack-name "communityops-${STAGE}" \
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
    --stack-name "communityops-${STAGE}" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[*].[OutputKey,OutputValue]" \
    --output table

# Seed demo data if requested
if [ "$SEED" = true ]; then
    TABLE_NAME=$(aws cloudformation describe-stacks \
        --stack-name "communityops-${STAGE}" \
        --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='MainTableName'].OutputValue" \
        --output text)

    echo ""
    echo "Seeding demo data to $TABLE_NAME..."
    PYTHONPATH=. python scripts/seed-demo.py --table "$TABLE_NAME" --region "$REGION"
fi

echo ""
echo "=== Deployment Complete ==="
