#!/bin/bash

# Configuration
SSM_PATH_PREFIX="/vvitu/prod"
REGION="ap-south-1"
ENV_FILE=".env"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}Starting export of secrets from $ENV_FILE to AWS SSM Parameter Store ($SSM_PATH_PREFIX)...${NC}"

if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}Error: $ENV_FILE not found!${NC}"
    exit 1
fi

# Ensure we have a GITHUB_TOKEN for the user-data script to clone the repo
echo -e "${GREEN}Checking for GITHUB_TOKEN...${NC}"
read -p "Enter your GitHub Personal Access Token (for cloning the repo in user-data): " GH_TOKEN
if [ ! -z "$GH_TOKEN" ]; then
    aws ssm put-parameter \
        --name "$SSM_PATH_PREFIX/GITHUB_TOKEN" \
        --value "$GH_TOKEN" \
        --type "SecureString" \
        --overwrite \
        --region "$REGION"
    echo "Uploaded GITHUB_TOKEN"
fi

# Read .env file line by line
while IFS='=' read -r key value || [ -n "$key" ]; do
    # Skip comments and empty lines
    if [[ $key =~ ^#.* ]] || [[ -z $key ]]; then
        continue
    fi
    
    # Trim whitespace from key and value
    key=$(echo "$key" | xargs)
    value=$(echo "$value" | xargs)

    # Remove quotes from value if present
    value="${value%\"}"
    value="${value#\"}"

    # Skip if key is empty after trimming
    if [ -z "$key" ]; then
        continue
    fi

    echo "Uploading $key..."
    
    # Upload to SSM
    aws ssm put-parameter \
        --name "$SSM_PATH_PREFIX/$key" \
        --value "$value" \
        --type "SecureString" \
        --overwrite \
        --region "$REGION"

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Successfully uploaded $key${NC}"
    else
        echo -e "${RED}Failed to upload $key${NC}"
    fi

done < "$ENV_FILE"

echo -e "${GREEN}All done! Your secrets are now in AWS SSM.${NC}"
echo "You can now verify the secrets in AWS Systems Manager > Parameter Store."
