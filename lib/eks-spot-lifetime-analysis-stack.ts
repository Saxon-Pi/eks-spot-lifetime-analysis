import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

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

export class EksSpotLifetimeAnalysisStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
  }
}
