import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import { KubectlV31Layer } from '@aws-cdk/lambda-layer-kubectl-v31';

/*
EKS Spot NodeGroup の安定性を評価するための検証スタック

Spot Instance のライフサイクルイベントや、
Kubernetes の Node / Pod イベントを収集し、
Spot interruption 発生時の復旧挙動を分析する

収集したイベントは CloudWatch Logs に集約し、
後続の集計・可視化・記事作成に利用する

Step1.
EC2 / Spot イベント収集
- Rebalance Recommendation
- Interruption Notice
- Instance State Change

Step2.
Kubernetes Event収集
- Node Ready / NotReady
- Pod Scheduled / Ready
- Pod Killing / Evicted

最終的に以下を分析する
- Spot Instance 生存時間
- Rebalance → Interruption の差分
- Interruption → Node Ready の時間
- Pod 停止時間
- Pod 再配置成功率
- Spot によるコスト削減効果
*/

/*
EKS Cluster 構成

EKS Cluster
├─ On-Demand NodeGroup
│  └─ CoreDNS / aws-node / kube-proxy / 監視系Pod (常時稼働 Workload): desired=1
└─ Spot NodeGroup
   └─ 検証 Workload 用: desired=2
*/

export class EksSpotLifetimeAnalysisStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =====================================================
    // CloudWatch Logs + EventBridge Rules
    // =====================================================

    // Spot / EC2 イベントを集約する CloudWatch Logs
    // (EventBridge → CloudWatch Logs)
    const spotEventLogGroup = new logs.LogGroup(this, 'SpotEventLogGroup', {
      logGroupName: '/eks/spot-test/ec2-events',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // 検証用
    });

    // Spot Instance の終了リスク上昇を通知する Rebalance Recommendation を取得する EventBridge Rule
    // → Rebalance 発生時刻を記録し、Rebalance → Interruption の差分分析に利用する
    new events.Rule(this, 'SpotRebalanceRule', {
      ruleName: 'eks-spot-rebalance-recommendation',
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance Rebalance Recommendation'],
      },
      targets: [new targets.CloudWatchLogGroup(spotEventLogGroup)],
    });

    // Spot 終了2分前通知をトリガーにする EventBridgeルール
    // → Interruption Notice 発生時刻を記録するため
    new events.Rule(this, 'SpotInterruptionRule', {
      ruleName: 'eks-spot-interruption-warning',
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Spot Instance Interruption Warning'],
      },
      targets: [new targets.CloudWatchLogGroup(spotEventLogGroup)],
    });

    // EC2インスタンスのステート変化をトリガーにするEventBridgeルール
    // → Instance 生存時間や、Interruption と Instance 終了までの差分を記録するため
    new events.Rule(this, 'EC2StateChangeRule', {
      ruleName: 'eks-spot-instance-state-change',
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: {
          state: ['pending', 'running', 'shutting-down', 'terminated'],
        },
      },
      targets: [new targets.CloudWatchLogGroup(spotEventLogGroup)],
    });

    // =====================================================
    // Network
    // =====================================================

    // NAT Gateway なしの検証用VPC
    const vpc = new ec2.Vpc(this, 'EksSpotTestVpc', {
      maxAzs: 2,
      natGateways: 0,
    });

    // ECR image pull 用
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
    });

    vpc.addInterfaceEndpoint('EcrDockerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });

    // CloudWatch Logs 出力用
    vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    });
    
    // AWS Security Token Service:
    // Pod / Add-on が IAM Role を引き受けるための一時認証情報を取得する
    vpc.addInterfaceEndpoint('StsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.STS,
    });

    vpc.addInterfaceEndpoint('Ec2Endpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.EC2,
    });

    vpc.addInterfaceEndpoint('EksEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.EKS,
    });

    vpc.addInterfaceEndpoint('CloudWatchMonitoringEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
    });

    vpc.addInterfaceEndpoint('LambdaEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.LAMBDA,
    });

    vpc.addInterfaceEndpoint('CloudFormationEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDFORMATION,
    });

    vpc.addInterfaceEndpoint('AutoscalingEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.AUTOSCALING,
    });

    // =====================================================
    // EKS Cluster + Managed NodeGroups
    // =====================================================

    // EKS Cluster (NATなし)
    const cluster = new eks.Cluster(this, 'EksSpotTestCluster', {
      clusterName: 'eks-spot-lifetime-test',
      version: eks.KubernetesVersion.V1_31,
      vpc,
      vpcSubnets: [
        {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
      defaultCapacity: 0,
      kubectlLayer: new KubectlV31Layer(this, 'KubectlLayer'),
      placeClusterHandlerInVpc: false,
    });

    // On-Demand NodeGroup: 
    // CoreDNS / aws-node / kube-proxy / 監視系Pod など、常時稼働 Workload 実行用
    cluster.addNodegroupCapacity('OnDemandNodeGroup', {
      nodegroupName: 'ondemand-system-ng',
      capacityType: eks.CapacityType.ON_DEMAND,
      desiredSize: 1,
      minSize: 1,
      maxSize: 1,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      instanceTypes: [
        new ec2.InstanceType('t3.medium'),
      ],
      labels: {
        'node-lifecycle': 'on-demand',
        'workload-type': 'system',
      },
    });

    // Spot NodeGroup: 検証 Workload 用
    cluster.addNodegroupCapacity('SpotNodeGroup', {
      nodegroupName: 'spot-workload-ng',
      capacityType: eks.CapacityType.SPOT,
      desiredSize: 2,
      minSize: 1,
      maxSize: 3,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      instanceTypes: [
        new ec2.InstanceType('t3.medium'),
        new ec2.InstanceType('t3a.medium'),
        new ec2.InstanceType('m5.large'),
        new ec2.InstanceType('m5a.large'),
        new ec2.InstanceType('m5n.large'),
        new ec2.InstanceType('m4.large'),
      ],
      labels: {
        'node-lifecycle': 'spot',
        'workload-type': 'spot-test', // nodeSelector 用
      },
      // toleration: spot=true の Pod のみを許容する
      taints: [
        {
          key: 'spot',
          value: 'true',
          effect: eks.TaintEffect.NO_SCHEDULE,
        },
      ],
    });

  }
}
