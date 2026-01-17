#!/bin/bash
set -euxo pipefail

exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

echo "===== VVIT ERP - PRODUCTION DEPLOY START (SSM) ====="

# -----------------------------
# 1. System Dependencies
# -----------------------------
apt-get update -y
apt-get install -y unzip jq git build-essential curl

# -----------------------------
# 2. Install Node.js 20.x
# -----------------------------
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# -----------------------------
# 3. Install AWS CLI v2
# -----------------------------
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip -q awscliv2.zip
./aws/install
rm -rf aws awscliv2.zip

# -----------------------------
# 4. Install Global NPM Packages
# -----------------------------
npm install -g pm2 typescript ts-node

# -----------------------------
# 5. Configuration
# -----------------------------
REGION="ap-south-1"
SSM_PATH="/vvitu/prod"
BASE_DIR="/var/www/erp"
APP_DIR="$BASE_DIR/vvit"

# -----------------------------
# 6. Fetch GitHub Token from SSM
# -----------------------------
echo "Fetching GITHUB_TOKEN from SSM..."
GITHUB_TOKEN=$(aws ssm get-parameter \
  --name "$SSM_PATH/GITHUB_TOKEN" \
  --with-decryption \
  --query "Parameter.Value" \
  --output text \
  --region "$REGION")

if [ -z "$GITHUB_TOKEN" ] || [ "$GITHUB_TOKEN" == "None" ]; then
    echo "❌ ERROR: GITHUB_TOKEN not found in SSM. Exiting."
    exit 1
fi

# -----------------------------
# 7. Setup Directory & Clone Repo
# -----------------------------
echo "Cloning repository..."
mkdir -p $BASE_DIR
cd $BASE_DIR
rm -rf vvit

git clone --depth 1 -b prod "https://x-access-token:${GITHUB_TOKEN}@github.com/Krishna909090/vvit.git" vvit
cd vvit

# -----------------------------
# 8. Generate .env from SSM
# -----------------------------
echo "Generating .env from SSM..."
aws ssm get-parameters-by-path \
    --path "$SSM_PATH/" \
    --recursive \
    --with-decryption \
    --region "$REGION" \
    --query "Parameters[*].{Name:Name,Value:Value}" \
    --output json > secrets.json

jq -r '.[] | "\(.Name | split("/") | last)=\"\(.Value)\""' secrets.json > .env.production
cp .env.production .env
rm secrets.json

# -----------------------------
# 9. Permissions
# -----------------------------
chown -R ubuntu:ubuntu $BASE_DIR

# -----------------------------
# 10. Build, Migrate, Seed, PM2
# -----------------------------
sudo -u ubuntu bash << 'EOF'
set -euxo pipefail

export PATH=$PATH:/usr/bin:/usr/local/bin
export NODE_ENV=production

cd /var/www/erp/vvit

echo "Installing dependencies..."
rm -rf node_modules
npm ci

echo "Generating Prisma Client..."
npx prisma generate

echo "Building project..."
npx tsc

echo "Running Prisma migrations..."
npx prisma migrate deploy

echo "Seeding data (safe mode)..."
npx ts-node scripts/seed-sms-config.ts || true
npx ts-node scripts/create-admin-user.ts || true

echo "Restarting PM2 processes..."
pm2 delete vvitu-prod-api || true
pm2 delete vvitu-prod-worker || true

pm2 start ecosystem.config.js --only vvitu-prod-api
pm2 start ecosystem.config.js --only vvitu-prod-worker
pm2 save
EOF

# -----------------------------
# 11. Enable PM2 on Boot
# -----------------------------
echo "Configuring PM2 startup..."
env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ubuntu --hp /home/ubuntu | bash
systemctl enable pm2-ubuntu
systemctl restart pm2-ubuntu

echo "===== ✅ VVIT ERP - DEPLOY COMPLETED SUCCESSFULLY ====="