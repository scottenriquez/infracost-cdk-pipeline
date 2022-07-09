resource "aws_instance" "server" {
  # Amazon Linux 2 Kernel 5.10 AMI 2.0.20220606.1 x86_64 HVM in us-east-1
  ami           = "ami-0cff7528ff583bf9a"
  instance_type = "t3.micro"
  subnet_id     = module.vpc.private_subnets[0]

  root_block_device {
    volume_type = "gp3"
    volume_size = 50
  }
}