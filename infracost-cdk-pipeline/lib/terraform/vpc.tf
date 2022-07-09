module "vpc" {
  source = "terraform-aws-modules/vpc/aws"

  name = "vpc-for-server"
  cidr = "10.0.0.0/16"

  azs             = ["us-east-1a"]
  private_subnets = ["10.0.0.0/16"]
}