output "api_endpoint" {
  description = "ReRIKAI API のエンドポイントURL"
  value       = "${aws_apigatewayv2_api.api.api_endpoint}/${aws_apigatewayv2_stage.api.name}"
}

output "web_cloudfront_domain" {
  description = "フロントエンド配信用CloudFrontドメイン"
  value       = aws_cloudfront_distribution.web.domain_name
}

output "data_bucket_name" {
  description = "Markdown・ノート写真保存用S3バケット名"
  value       = aws_s3_bucket.data.bucket
}

output "web_bucket_name" {
  description = "フロントエンド配信用S3バケット名"
  value       = aws_s3_bucket.web.bucket
}

output "dynamodb_table_name" {
  description = "ReRIKAI用DynamoDBテーブル名"
  value       = aws_dynamodb_table.ririkai.name
}

output "lambda_function_name" {
  description = "ReRIKAI用Lambda関数名"
  value       = aws_lambda_function.api.function_name
}
