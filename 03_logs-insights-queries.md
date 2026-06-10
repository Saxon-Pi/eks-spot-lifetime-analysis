# CloudWatch Logs Insights Queries

## 概要

本ドキュメントは、EKS Spot Instance Lifetimeテストで発生するイベントを  
CloudWatch Logs Insightsから調査するためのクエリ集である  

以下のイベントを時系列で追跡可能  

1. AWS Spot/Rebalance通知
2. Node Termination HandlerによるNode Drain
3. KubernetesによるPod Evictionおよび再スケジューリング
4. アプリケーションのGraceful Shutdown

| クエリ | 目的 | 得られる情報 | 主な確認タイミング |
| --- | --- | --- | --- |
| アプリイベント | アプリがNode終了を検知して正常終了したか確認する | Pod名、Node名、アプリ独自イベント（SIGTERM受信、Graceful Shutdown開始/完了など） | Spot終了時のアプリ挙動確認 |
| Kubernetes Event | Kubernetes全体で何が起きたか確認する | Scheduled、Killing、Pulling、CreatedなどのK8sイベント | 障害調査や時系列確認 |
| drain / eviction / killing | Pod退避処理の流れを追跡する | Eviction、Pod削除、再作成、再スケジューリング | NTHや手動drainの動作確認 |
| NTHログ | NTHがSpot終了通知を受け取ったか確認する | Rebalance Recommendation、Spot Interruption、Drain開始・完了ログ | Spotイベント発生時 |
| Spot / Rebalance EventBridge | AWSが実際にSpot通知を発行したか確認する | Spot Interruption Warning、Rebalance Recommendation、対象EC2情報 | AWS側の通知有無確認 |


各ログの確認範囲を時系列で表すと以下のイメージとなる   

```text
① AWS
│
├─ Spot Interruption Warning
└─ Rebalance Recommendation
        ↓
② EventBridge
        ↓
③ NTHログ
   "received interruption"
   "cordon node"
   "drain node"
        ↓
④ Kubernetes Event
   Eviction
   Killing
   Scheduled
   Started
        ↓
⑤ アプリイベント
   SIGTERM受信
   Graceful Shutdown
   終了
```

## アプリイベント確認

対象ロググループ:  
/aws/containerinsights/eks-spot-lifetime-test/application  

```sql
fields @timestamp,
       log_processed.event,
       log_processed.pod_name,
       log_processed.node_name
| filter kubernetes.namespace_name = "spot-test"
| filter ispresent(log_processed.event)
| sort @timestamp desc
| limit 100
```

## Kubernetes Event 確認

```sql
fields @timestamp,
       log_processed.reason,
       log_processed.message,
       log_processed.involvedObject.kind,
       log_processed.involvedObject.name,
       log_processed.involvedObject.namespace
| filter kubernetes.pod_name like /kubernetes-event-exporter/
| filter ispresent(log_processed.reason)
| sort @timestamp desc
| limit 100
```

## drain / eviction / killing 確認

```sql
fields @timestamp,
       log_processed.reason,
       log_processed.message,
       log_processed.involvedObject.kind,
       log_processed.involvedObject.name
| filter kubernetes.pod_name like /kubernetes-event-exporter/
| filter log_processed.reason in ["Killing", "SuccessfulDelete", "Scheduled", "SuccessfulCreate"]
| sort @timestamp asc
| limit 200
```

## NTH ログ確認

```sql
fields @timestamp,
       log,
       kubernetes.pod_name,
       kubernetes.host
| filter kubernetes.pod_name like /aws-node-termination-handler/
| sort @timestamp desc
| limit 100
```

## Spot / Rebalance EventBridge 確認

対象ロググループ:  
/aws/events/eks-spot-lifetime-test  

```sql
fields @timestamp,
       `detail-type`,
       detail.instance-id,
       detail.instance-action,
       detail.availability-zone
| sort @timestamp desc
| limit 100
```
