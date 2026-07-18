variable "aws_region" {
  description = "AWSリージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "user_id" {
  description = "シングルユーザー構成での固定userId"
  type        = string
  default     = "naohiro"
}

variable "data_bucket_name" {
  description = "Markdown・ノート写真を保存するS3バケット名"
  type        = string
  default     = "ririkai-data-naohiro"
}

variable "web_bucket_name" {
  description = "フロントエンド静的ファイルを配信するS3バケット名"
  type        = string
  default     = "ririkai-web-naohiro"
}

variable "openai_secret_id" {
  description = "既存のOpenAI APIキーを保持するSecrets ManagerのシークレットID（Eureka Study分を再利用）"
  type        = string
  default     = "eureka-study/openai"
}

variable "openai_model" {
  description = "OpenAI APIのモデル名"
  type        = string
  default     = "gpt-4.1"
}
