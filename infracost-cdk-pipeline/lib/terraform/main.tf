terraform {
  backend "s3" {
    key    = "infrastructure.tfstate"
    region = "us-east-1"
  }
}

provider "aws" {
  region = "us-east-1"
}