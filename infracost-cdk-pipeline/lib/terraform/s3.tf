resource "random_string" "random_bucket_entropy" {
  length = 8
  special = false
  lower = true
  upper = false
}

resource "aws_s3_bucket" "bucket" {
  bucket = "infracost-test-bucket-${random_string.random_bucket_entropy.result}"
}