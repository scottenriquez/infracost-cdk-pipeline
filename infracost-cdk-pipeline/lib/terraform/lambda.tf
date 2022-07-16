resource "random_string" "random_lambda_entropy" {
  length = 8
  special = false
  lower = true
  upper = false
}

resource "aws_iam_role" "lambda_role" {
  name = "lambda_role_${random_string.random_lambda_entropy.result}"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF
}

resource "aws_lambda_function" "function" {
  filename      = "./lambda/function.zip"
  function_name = "sample_function_${random_string.random_lambda_entropy.result}"
  handler       = "exports.handler"
  role          = aws_iam_role.lambda_role.arn
  runtime       = "nodejs16.x"
  memory_size   = 1024
}