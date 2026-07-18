data "archive_file" "backend" {
  type        = "zip"
  source_dir  = "${path.module}/../backend"
  output_path = "${path.module}/build/backend.zip"
  excludes    = ["test"]
}

resource "aws_lambda_function" "api" {
  function_name = "ReRikaiApi"
  role          = aws_iam_role.lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  timeout       = 210
  memory_size   = 512

  filename         = data.archive_file.backend.output_path
  source_code_hash = data.archive_file.backend.output_base64sha256

  environment {
    variables = {
      DATA_BUCKET      = aws_s3_bucket.data.bucket
      OPENAI_SECRET_ID = var.openai_secret_id
      OPENAI_MODEL     = var.openai_model
      USER_ID          = var.user_id
    }
  }

  tags = {
    Project = "ReRIKAI"
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${aws_lambda_function.api.function_name}"
  retention_in_days = 30

  tags = {
    Project = "ReRIKAI"
  }
}
