# 既存のOpenAI用シークレット（Eureka Study分）を参照するのみで、管理下には置かない。
data "aws_secretsmanager_secret" "openai" {
  name = var.openai_secret_id
}

data "aws_caller_identity" "current" {}

resource "aws_iam_role" "lambda" {
  name = "ReRikaiLambdaRole"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Project = "ReRIKAI"
  }
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_dynamodb" {
  name = "ReRikaiLambdaDynamoDbPolicy"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query"
        ]
        Resource = aws_dynamodb_table.ririkai.arn
      }
    ]
  })
}

resource "aws_iam_role_policy" "lambda_s3" {
  name = "ReRikaiLambdaS3Policy"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject"
        ]
        Resource = "${aws_s3_bucket.data.arn}/*"
      }
    ]
  })
}

resource "aws_iam_role_policy" "lambda_secrets" {
  name = "ReRikaiLambdaSecretsPolicy"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = data.aws_secretsmanager_secret.openai.arn
      }
    ]
  })
}

# 非同期ジョブ処理のため、Lambdaが自分自身をEvent呼び出しできるようにする。
resource "aws_iam_role_policy" "lambda_self_invoke" {
  name = "ReRikaiLambdaSelfInvokePolicy"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = aws_lambda_function.api.arn
      }
    ]
  })
}
