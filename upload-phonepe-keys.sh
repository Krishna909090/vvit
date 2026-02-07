#!/bin/bash
# Uploads newly added PhonePe keys to AWS SSM Parameter Store
# Region: us-east-1 (Matching .env)
# Prefix: /vvitu/prod (Matching upload-secrets.sh convention)

REGION="us-east-1"
PREFIX="/vvitu/prod"

func_upload() {
    key=$1
    value=$2
    echo "Uploading $key to $PREFIX/$key in $REGION..."
    aws ssm put-parameter \
        --name "$PREFIX/$key" \
        --value "$value" \
        --type "SecureString" \
        --overwrite \
        --region "$REGION"
}

func_upload "HOSTEL_PHONEPE_MERCHANT_ID" "VVITFEEONLINE_2512111619"
func_upload "HOSTEL_PHONEPE_SALT_KEY" "MGQ4MzNmMmEtNmEzZC00M2JiLWE1NGUtZDdlNjA1MTI0ZTcx"
func_upload "HOSTEL_PHONEPE_SALT_INDEX" "1"

func_upload "MESS_PHONEPE_MERCHANT_ID" "VVITFEEONLINE_2512111619"
func_upload "MESS_PHONEPE_SALT_KEY" "MGQ4MzNmMmEtNmEzZC00M2JiLWE1NGUtZDdlNjA1MTI0ZTcx"
func_upload "MESS_PHONEPE_SALT_INDEX" "1"

echo "Done."
