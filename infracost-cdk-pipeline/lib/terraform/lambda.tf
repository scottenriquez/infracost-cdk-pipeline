resource "aws_iam_role" "lambda_role" {
  name = "lambda_role"

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
  function_name = "sample_function"
  handler       = "exports.handler"
  role          = aws_iam_role.lambda_role.arn
  runtime       = "nodejs16.x"
  memory_size   = 1024
}