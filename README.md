## Solution Overview
My current role focuses on every facet of AWS cost optimization. Much of this entails helping to remediate existing infrastructure and usage. Many customers ask how they can shift left on cloud costs, like they do with security. Ultimately, cost consciousness needs to be injected into every aspect of the engineering lifecycle: from the initial architecture design to implementation and upkeep.

One such aspect is providing developers visibility into the impact of their code changes. Infrastructure as code has made it easy to deploy cloud resources faster and at larger scale than ever before, but this means that cloud bills can also scale up quickly in parallel. This solution demonstrates how to integrate [Infracost](https://www.infracost.io/) into a deployment pipeline to bring cost impact to the pull request process and code review discussion. The source code is [hosted on GitHub](https://github.com/scottenriquez/infracost-cdk-pipeline).

## Solution Architecture 
This solution deploys several resources:
- A CodeCommit repository pre-loaded with Terraform code for a VPC, EC2 instance, S3 bucket, and Lambda function to serve as some example infrastructure costs to monitor
- A CodeBuild project triggered by pull request state changes that analyzes cost changes relative to the `main` branch
- A CodePipeline with manual approvals to deploy the Terraform for changes pushed to the `main` branch
- An SNS topic to notify developers of cost changes
- An S3 bucket to store Terraform state remotely
- An S3 bucket to store CodePipeline artifacts


## Preparing Your Development Environment 
While this solution is for writing, deploying, and analyzing Terraform HCL syntax, I wrote the infrastructure code for the deployment pipeline and dependent resources using AWS CDK, which is my daily driver for infrastructure as code. Of course, the source code could be rewritten using Terraform or [CDK for Terraform](https://www.terraform.io/cdktf), but I used CDK for the sake of a quick prototype that only creates AWS resources (i.e., no need for additional providers). In addition, Infracost currently only supports Terraform, but there are [plans for CloudFormation and CDK](https://www.infracost.io/docs/supported_resources/overview/) in the future.

The following dependencies are required to deploy the pipeline infrastructure:
- An AWS account
- Node.js
- Terraform
- [AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html)
- [An Infracost API key](https://www.infracost.io/docs/)
- [Source code](https://github.com/scottenriquez/infracost-cdk-pipeline)

Rather than installing Node.js, CDK, Terraform, and all other dependencies on your local machine, you can alternatively create a [Cloud9 IDE](https://aws.amazon.com/cloud9/) with these pre-installed via the Console or with a CloudFormation template:
```yaml
Resources:
  rCloud9Environment:
    Type: AWS::Cloud9::EnvironmentEC2
    Properties:
      AutomaticStopTimeMinutes: 30
      ConnectionType: CONNECT_SSH 
      Description: Environment for writing and deploying CDK 
      # AWS Free Tier eligible
      InstanceType: t2.micro	
      Name: InfracostCDKPipelineCloud9Environment
      # https://docs.aws.amazon.com/cloud9/latest/user-guide/vpc-settings.html#vpc-settings-create-subnet
      SubnetId: subnet-EXAMPLE 
```

## Installation, Deployment, and Configuration
Before deploying the CDK application, [store the Infracost API key in an SSM parameter](https://docs.aws.amazon.com/systems-manager/latest/userguide/parameter-create-console.html) `SecureString` called `/terraform/infracost/api_key`.

To install and deploy the pipeline, use the following commands:
```shell
git clone https://github.com/scottenriquez/infracost-cdk-pipeline.git
cd infracost-cdk-pipeline/infracost-cdk-pipeline/
npm install
# https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html
cdk bootstrap
cdk deploy
```

Before testing the pipeline, [subscribe to the SNS topic via the Console](https://docs.aws.amazon.com/sns/latest/dg/sns-create-subscribe-endpoint-to-topic.html). For testing purposes, use email to get the cost change data delivered.

## Using the Deployment Pipeline
The CodePipeline is triggered at creation, but there are manual approval stages to prevent any infrastructure from being created without intervention. Feel free to deploy the Terraform, but it is not required for generating cost differences via a pull request. The CodePipeline is triggered by changes to `main`.

Make some code changes to see the cost impact. To modify the Terraform code, either use the CodeCommit GUI in the Console or clone the repository to your development environment. First, create a branch called `feature` off of `main`. Then modify `ec2.tf` to use a different instance type:
```hcl
resource "aws_instance" "server" {
  # Amazon Linux 2 Kernel 5.10 AMI 2.0.20220606.1 x86_64 HVM in us-east-1
  # if deploying outside of us-east-1, you must use the corresponding AL2 AMI for your region
  ami           = "ami-0cff7528ff583bf9a"
  # changed from t3.micro
  instance_type = "m5.large"
  subnet_id     = module.vpc.private_subnets[0]

  root_block_device {
    volume_type = "gp3"
    volume_size = 50
  }
}
```

Infracost also supports usage estimates in addition to resource costs. For example, changing the storage GBs for the S3 bucket in `infracost-usage.yml` will also update the cost comparison and estimate. These values are hardcoded and version-controlled here, but Infracost is also [experimenting with fetching actual usage data via CloudWatch](https://www.infracost.io/docs/features/usage_based_resources/).

```yaml
version: 0.1
resource_usage:
  aws_lambda_function.function:
    monthly_requests: 10000 
    request_duration_ms: 250
  aws_s3_bucket.bucket:
    standard:
      # changed from 10000
      storage_gb: 15000
      monthly_tier_1_requests: 1000 
```

Commit these changes to the `feature` branch and open a pull request. Doing so will trigger the CodeBuild project that computes the cost delta and publishes the payload to the SNS topic if the amount increases. Assuming you subscribed to the SNS topic via email, some JSON should be in your inbox. Here's an abridged example output:
```json
{
	"version": "0.2",
	"currency": "USD",
	"projects": [{
		"name": "codecommit::us-east-1://TerraformRepository/.",
		"metadata": {
			"path": "/tmp/main",
			"infracostCommand": "breakdown",
			"type": "terraform_dir",
			"branch": "main",
			"commit": "2e6eafd94811a0c9ac814a8c31132dc3badc0b9f",
			"commitAuthorName": "AWS CodeCommit",
			"commitAuthorEmail": "noreply-awscodecommit@amazon.com",
			"commitTimestamp": "2022-07-16T05:47:50Z",
			"commitMessage": "Initial commit by AWS CodeCommit",
			"vcsRepoUrl": "codecommit::us-east-1://TerraformRepository",
			"vcsSubPath": "."
		}
	}],
	"totalHourlyCost": "0.41661461198630137000733251",
	"totalMonthlyCost": "304.12866675",
	"pastTotalHourlyCost": "0.33101461198630137000733251",
	"pastTotalMonthlyCost": "241.64066675",
	"diffTotalHourlyCost": "0.0856",
	"diffTotalMonthlyCost": "62.488",
	"timeGenerated": "2022-07-16T06:21:02.155239211Z",
	"summary": {
		"totalDetectedResources": 3,
		"totalSupportedResources": 3,
		"totalUnsupportedResources": 0,
		"totalUsageBasedResources": 3,
		"totalNoPriceResources": 0,
		"unsupportedResourceCounts": {},
		"noPriceResourceCounts": {}
	}
}
```

## Diving Into the Pull Request Build Logic
The TypeScript for describing the deployment pipeline lives in `infracost-cdk-pipeline-stack.ts`. The following code snippet (with comments explaining the `install` and `build` phases) contains the core logic for integrating Infracost into the pull request: 
```typescript
const pullRequestCodeBuildProject = new codebuild.Project(this, 'TerraformPullRequestCodeBuildProject', {
    buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
            install: {
                commands: [
                    // checkout the feature branch
                    'git checkout $CODEBUILD_SOURCE_VERSION',
                    'sudo yum -y install unzip python3-pip jq',
                    'sudo pip3 install git-remote-codecommit',
                    `wget https://releases.hashicorp.com/terraform/${terraformVersion}/terraform_${terraformVersion}_linux_amd64.zip`,
                    `unzip terraform_${terraformVersion}_linux_amd64.zip`,
                    'sudo mv terraform /usr/local/bin/',
                    'curl -fsSL https://raw.githubusercontent.com/infracost/infracost/master/scripts/install.sh | sh',
                    // clone the main branch
                    `git clone ${terraformRepository.repositoryCloneUrlGrc} --branch=${mainBranchName} --single-branch /tmp/main`,
                    // generate Infracost baseline file for main
                    'infracost breakdown --path /tmp/main --usage-file infracost-usage.yml --format json --out-file infracost-main.json'
                ]
            },
            build: {
                commands: [
                    // initialize Terraform with remote state
                    `terraform init -backend-config="bucket=${terraformStateBucket.bucketName}"`,
                    'terraform plan',
                    // compute diff based on baseline created from main
                    'infracost diff --path . --compare-to infracost-main.json --usage-file infracost-usage.yml --format json --out-file infracost-pull-request.json',
                    // parse JSON to get total monthly difference
                    `DIFF_TOTAL_MONTHLY_COST=$(jq '.diffTotalMonthlyCost | tonumber | floor' infracost-pull-request.json)`,
                    // if there's a cost increase, publish the diff to the SNS topic
                    `if [[ $DIFF_TOTAL_MONTHLY_COST -gt 0 ]]; then aws sns publish --topic-arn ${terraformCostTopic.topicArn} --message file://infracost-pull-request.json; fi`
                ]
            }
        }
    })
});
```

More advanced notification logic, such as using the percentage increase for an alert threshold, could be implemented to minimize noise for developers. Additionally, offloading the logic to a Lambda function and invoking it via the CLI or SNS would allow for more robust and testable logic than a simple shell script. Alternatively, the cost delta could be added as a comment on the source pull request. Choose the option that makes the most sense for your code review process.

## Conclusion
Technology alone will not resolve all cost optimization challenges. However, integrating cost analysis into code reviews is integral to shaping a cost-conscious culture. It is much better to find and address cost spikes before infrastructure is deployed. Seeing a large cost increase from `infracost diff` is scary, but seeing it in Cost Explorer later is far scarier.

## Cleanup
If you deployed resources via the deployment pipeline, be sure to either use the `DestroyTerraform` CodeBuild project or run:
```shell
# set the bucket name variable or replace with a value
# the bucket name nomenclature is 'terraform-state-' followed by a UUID
# this can also be found via the Console
terraform init -backend-config="bucket=$TERRAFORM_STATE_S3_BUCKET_NAME"
terraform destroy
```

To destroy the pipeline itself run:
```shell
cdk destroy
```

If you spun up a Cloud9 environment, be sure to delete that as well.

## Disclaimer
At the time of writing this blog post, I currently work for Amazon Web Services. The opinions and views expressed here are my own and not the views of my employer.