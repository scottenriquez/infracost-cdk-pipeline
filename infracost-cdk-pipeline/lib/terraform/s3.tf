resource "random_string" "random" {
  length = 8
  special = false
}

resource "aws_s3_bucket" "bucket" {
  bucket = "infracost-test-bucket-${random_string.random.result}"
}