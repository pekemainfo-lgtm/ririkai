resource "aws_dynamodb_table" "ririkai" {
  name         = "ReRikaiTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  # 実データ保護（§17）。誤操作からの復旧と、テーブルの誤削除防止。
  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  # JOB#... アイテムを一定期間後に自動失効させる（永続索引のSESSION#...アイテムには設定しない）。
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = {
    Project = "ReRIKAI"
  }
}
