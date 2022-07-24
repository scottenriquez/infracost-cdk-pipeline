import * as path from 'path';
import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as uuid from 'uuid';

export class InfracostCdkPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // constants
    const terraformVersion = '1.2.4';
    const mainBranchName = 'main';
    const infracostAPIKeyParameterSecureStringName = '/terraform/infracost/api_key';

    // Terraform state management
    const terraformStateBucket = new s3.Bucket(this, 'TerraformStateBucket', {
      autoDeleteObjects: true,
      bucketName: `terraform-state-${uuid.v4()}`,
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Terraform cost SNS topic
    const terraformCostTopic = new sns.Topic(this, 'TerraformCostTopic');

    // IAM permissions for CodeBuild
    const terraformS3IAMPolicyForCodeBuild = new iam.ManagedPolicy(this, 'S3CodeBuildManagedPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          resources: [terraformStateBucket.arnForObjects('*')]
        }),
        new iam.PolicyStatement({
          actions: ['s3:ListBucket'],
          resources: ['*']
        })
      ]
    });
    const terraformSNSIAMPolicyForCodeBuild = new iam.ManagedPolicy(this, 'SNSCodeBuildManagedPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['sns:Publish'],
          resources: [terraformCostTopic.topicArn]
        })
      ]
    });
    const terraformPlanCodeBuildRole = new iam.Role(this, 'TerraformPlanCodeBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description: 'IAM role for CodeBuild to interact with S3',
      managedPolicies: [
        terraformS3IAMPolicyForCodeBuild,
        terraformSNSIAMPolicyForCodeBuild, 
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeCommitReadOnly'), 
        iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')]
    });

    // Terraform source code
    const terraformRepository = new codecommit.Repository(this, 'TerraformRepository', {
      repositoryName: 'TerraformRepository',
      code: codecommit.Code.fromDirectory(path.join(__dirname, 'terraform/'), mainBranchName)
    });

    // pull request build and integration
    const terraformPullRequestCodeBuildProject = new codebuild.Project(this, 'TerraformPullRequestCodeBuildProject', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'git checkout $CODEBUILD_SOURCE_VERSION',
              'sudo yum -y install unzip python3-pip jq',
              'sudo pip3 install git-remote-codecommit',
              `wget https://releases.hashicorp.com/terraform/${terraformVersion}/terraform_${terraformVersion}_linux_amd64.zip`,
              `unzip terraform_${terraformVersion}_linux_amd64.zip`,
              'sudo mv terraform /usr/local/bin/',
              'curl -fsSL https://raw.githubusercontent.com/infracost/infracost/master/scripts/install.sh | sh',
              `git clone ${terraformRepository.repositoryCloneUrlGrc} --branch=${mainBranchName} --single-branch /tmp/main`,
              'infracost breakdown --path /tmp/main --usage-file infracost-usage.yml --format json --out-file infracost-main.json'
            ]
          },
          build: {
            commands:[
              `terraform init -backend-config="bucket=${terraformStateBucket.bucketName}"`,
              'terraform plan',
              'infracost diff --path . --compare-to infracost-main.json --usage-file infracost-usage.yml --format json --out-file infracost-pull-request.json',
              `DIFF_TOTAL_MONTHLY_COST=$(jq '.diffTotalMonthlyCost | tonumber | floor' infracost-pull-request.json)`,
              `if [[ $DIFF_TOTAL_MONTHLY_COST -gt 0 ]]; then aws sns publish --topic-arn ${terraformCostTopic.topicArn} --message file://infracost-pull-request.json; fi`
            ]
          }
        }
      }),
      source: codebuild.Source.codeCommit({
        repository: terraformRepository
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
        environmentVariables: {
          INFRACOST_API_KEY: {
            value: infracostAPIKeyParameterSecureStringName,
            type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE
          }
        },
        privileged: true
      },
      role: terraformPlanCodeBuildRole 
    });
    const pullRequestStateChangeRule = terraformRepository.onPullRequestStateChange('TerraformRepositoryOnPullRequestStateChange', {
      eventPattern: {
        detail: {
          // only run build for open pull requests
          pullRequestStatus: ['Open']
        } 
      },
      target: new targets.CodeBuildProject(terraformPullRequestCodeBuildProject, {
        event: events.RuleTargetInput.fromObject({
          sourceVersion: events.EventField.fromPath('$.detail.sourceReference')
        })
      })
    });

    // IAM permissions for pipeline
    const terraformCodeBuildDeployRole = new iam.Role(this, 'TerraformCodeBuildDeployRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description: 'IAM role for Terraform deployments in CodeBuild',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')]
    });

    // pipeline
    const codePipelineArtifactBucket = new s3.Bucket(this, 'CodePipelineArtifactBucket', {
      autoDeleteObjects: true,
      bucketName: `codepipeline-artifact-${uuid.v4()}`,
      removalPolicy: RemovalPolicy.DESTROY
    });
    const terraformPlanCodeBuildProject = new codebuild.PipelineProject(this, 'TerraformPlanCodeBuildProject', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        artifacts: {
          files: ['*.tf', 'lambda/*', 'tfplan.out']
        },
        phases: {
          install: {
            commands: [
              `wget https://releases.hashicorp.com/terraform/${terraformVersion}/terraform_${terraformVersion}_linux_amd64.zip`,
              'sudo yum -y install unzip',
              `unzip terraform_${terraformVersion}_linux_amd64.zip`,
              'sudo mv terraform /usr/local/bin/',
              'curl -fsSL https://raw.githubusercontent.com/infracost/infracost/master/scripts/install.sh | sh'
            ]
          },
          build: {
            commands:[
              `terraform init -backend-config="bucket=${terraformStateBucket.bucketName}"`,
              'terraform plan -out tfplan.out',
              'infracost breakdown --path . --usage-file infracost-usage.yml --format table'
            ]
          }
        }
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
        environmentVariables: {
          INFRACOST_API_KEY: {
            value: infracostAPIKeyParameterSecureStringName,
            type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE
          }
        },
        privileged: true
      },
      role: terraformPlanCodeBuildRole 
    });
    const terraformApplyCodeBuildProject = new codebuild.PipelineProject(this, 'TerraformApplyCodeBuildProject', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              `wget https://releases.hashicorp.com/terraform/${terraformVersion}/terraform_${terraformVersion}_linux_amd64.zip`,
              'sudo yum -y install unzip',
              `unzip terraform_${terraformVersion}_linux_amd64.zip`,
              'sudo mv terraform /usr/local/bin/',
              'curl -fsSL https://raw.githubusercontent.com/infracost/infracost/master/scripts/install.sh | sh'
            ]
          },
          build: {
            commands:[
              `terraform init -backend-config="bucket=${terraformStateBucket.bucketName}"`,
              'terraform apply tfplan.out',
            ]
          }
        }
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
        environmentVariables: {
          INFRACOST_API_KEY: {
            value: infracostAPIKeyParameterSecureStringName,
            type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE
          }
        },
        privileged: true
      },
      role: terraformCodeBuildDeployRole 
    });
    const terraformPipeline = new codepipeline.Pipeline(this, 'TerraformPipeline', {
      artifactBucket: codePipelineArtifactBucket,
      pipelineName: 'TerraformPipeline'
    });
    const sourceStage = terraformPipeline.addStage({
      stageName: 'Source'
    });
    const sourceArtifact = new codepipeline.Artifact();
    sourceStage.addAction(new codepipeline_actions.CodeCommitSourceAction({
      actionName: 'Source',
      branch: mainBranchName,
      output: sourceArtifact,
      repository: terraformRepository
    }));
    const approveBuildStage = terraformPipeline.addStage({ 
      stageName: 'ApproveBuild' 
    });
    const buildManualApprovalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: 'ApproveBuild',
    });
    approveBuildStage.addAction(buildManualApprovalAction);
    const buildStage = terraformPipeline.addStage({
      stageName: 'Build'
    });
    const terraformPlanArtifact = new codepipeline.Artifact();
    buildStage.addAction(new codepipeline_actions.CodeBuildAction({
      actionName: 'BuildTerraform',
      input: sourceArtifact,
      outputs: [terraformPlanArtifact],
      project: terraformPlanCodeBuildProject
    }));
    const approveDeployStage = terraformPipeline.addStage({ 
      stageName: 'ApproveDeploy' 
    });
    const deployManualApprovalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: 'ApproveDeploy',
    });
    approveDeployStage.addAction(deployManualApprovalAction);
    const deployStage = terraformPipeline.addStage({
      stageName: 'Deploy'
    });
    deployStage.addAction(new codepipeline_actions.CodeBuildAction({
      actionName: 'DeployTerraform',
      input: terraformPlanArtifact,
      project: terraformApplyCodeBuildProject
    }));

    // destroy build
    const terraformDestroyCodeBuildProject = new codebuild.Project(this, 'TerraformDestroyCodeBuildProject', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'sudo yum -y install unzip',
              `wget https://releases.hashicorp.com/terraform/${terraformVersion}/terraform_${terraformVersion}_linux_amd64.zip`,
              `unzip terraform_${terraformVersion}_linux_amd64.zip`,
              'sudo mv terraform /usr/local/bin/'
            ]
          },
          build: {
            commands:[
              `terraform init -backend-config="bucket=${terraformStateBucket.bucketName}"`,
              'terraform destroy -auto-approve'
            ]
          }
        }
      }),
      source: codebuild.Source.codeCommit({
        repository: terraformRepository
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
        privileged: true
      },
      role: terraformCodeBuildDeployRole 
    });
  }
}
