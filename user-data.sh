#!/bin/bash
set -x
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1

# ==========================================
# VVIT ERP - Production Launch Script
# ==========================================

echo "Starting user-data script..."

# 1. Install System Dependencies
echo "Installing dependencies..."
apt-get update -y
apt-get install -y unzip jq git

# 2. Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 3. Install AWS CLI v2
echo "Installing AWS CLI..."
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip -q awscliv2.zip
./aws/install
rm awscliv2.zip

# 4. Install Global Node Packages
echo "Installing PM2 and TypeScript..."
npm install -g pm2 typescript ts-node

# 5. Fetch Secrets & Configure Environment
echo "Fetching GITHUB_TOKEN..."
REGION="ap-south-1"
SSM_PATH="/vvitu/prod"

# Fetch GITHUB_TOKEN individually to clone
GITHUB_TOKEN=$(aws ssm get-parameter --name "$SSM_PATH/GITHUB_TOKEN" --with-decryption --query "Parameter.Value" --output text --region $REGION)

if [ -z "$GITHUB_TOKEN" ] || [ "$GITHUB_TOKEN" == "None" ]; then
    echo "ERROR: GITHUB_TOKEN not found in SSM ($SSM_PATH/GITHUB_TOKEN). Cannot clone repo."
    # Fallback or exit? We can try to proceed if repo is public, but it's likely private.
    exit 1
fi

# 6. Clone Repository
echo "Cloning repository..."
APP_DIR="/var/www/erp/vvit"
mkdir -p /var/www/erp
cd /var/www/erp

# Using OAuth token for clone
git clone -b prod "https://x-access-token:${GITHUB_TOKEN}@github.com/Krishna909090/vvit.git" vvit
cd vvit

# Check if clone successful
if [ ! -d ".git" ]; then
    echo "ERROR: Git clone failed."
    exit 1
fi

# 7. Install Dependencies & Build
echo "Installing project dependencies..."
npm ci

echo "Building project..."
npm run build

# 8. Generate .env.production from SSM
echo "Generating .env.production..."
# Fetch all parameters in path
aws ssm get-parameters-by-path \
    --path "$SSM_PATH/" \
    --recursive \
    --with-decryption \
    --region "$REGION" \
    --query "Parameters[*].{Name:Name,Value:Value}" \
    --output json > secrets.json

# Parse JSON to .env format
# Removes the prefix /vvitu/prod/ from the key name
jq -r '.[] | "\(.Name | split("/") | last)=\"\(.Value)\""' secrets.json > .env.production
rm secrets.json

# Ensure permissions
chown -R ubuntu:ubuntu /var/www/erp

# 9. Start Application with PM2
echo "Starting application with PM2..."
# We run PM2 as 'ubuntu' user so it has the right home directory and permissions
sudo -u ubuntu pm2 start ecosystem.config.js --only vvitu-prod-api,vvitu-prod-worker

# 10. Enable PM2 Persistence
echo "Enabling PM2 startup..."
sudo -u ubuntu pm2 save

# Generate and run startup script for ubuntu user
# This command mimics what 'pm2 startup' tells you to run
env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ubuntu --hp /home/ubuntu
sudo -u ubuntu pm2 save
systemctl start pm2-ubuntu

echo "User data script completed successfully!"
