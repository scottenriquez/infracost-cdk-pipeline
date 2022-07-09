import * as path from 'path';
import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions'
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as uuid from 'uuid';

export class InfracostCdkPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const terraformVersion = '1.2.4';
    const terraformStateBucket = new s3.Bucket(this, 'TerraformStateBucket', {
      bucketName: `terraform-state-${uuid.v4()}`,
      removalPolicy: RemovalPolicy.DESTROY
    });
    const terraformRepository = new codecommit.Repository(this, 'TerraformRepository', {
      repositoryName: 'TerraformRepository',
      code: codecommit.Code.fromDirectory(path.join(__dirname, 'terraform/'), 'main')
    });
    const terraformCodeBuildProject = new codebuild.PipelineProject(this, 'TerraformCodeBuildProject', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              `wget https://releases.hashicorp.com/terraform/${terraformVersion}/terraform_${terraformVersion}_linux_amd64.zip`,
              'sudo yum -y install unzip',
              `unzip terraform_${terraformVersion}_linux_amd64.zip`,
              'sudo mv terraform /usr/local/bin/',
              'terraform --version'
            ]
          },
          build: {
            commands:[
              `terraform init -backend-config="${terraformStateBucket.bucketName}"`,
              'terraform plan'
            ]
          }
        }
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3
      }
    });
    const terraformPipeline = new codepipeline.Pipeline(this, 'TerraformPipeline', {
      pipelineName: 'TerraformPipeline'
    });
    const sourceStage = terraformPipeline.addStage({
      stageName: 'Source'
    });
    const sourceArtifact = new codepipeline.Artifact();
    sourceStage.addAction(new codepipeline_actions.CodeCommitSourceAction({
      actionName: 'Source',
      branch: 'main',
      output: sourceArtifact,
      repository: terraformRepository
    }));
    const buildStage = terraformPipeline.addStage({
      stageName: 'Build'
    });
    buildStage.addAction(new codepipeline_actions.CodeBuildAction({
      actionName: 'BuildTerraform',
      input: sourceArtifact,
      project: terraformCodeBuildProject
    }));
  }
}
