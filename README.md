# EKS Spot Instance Lifetime Test

## 概要

本プロジェクトは、Amazon EKS 上で稼働するアプリケーションを Spot Instance 上に配置し、  
Spot Instance 終了時にサービスを継続できる仕組みを検証するための環境である  

単純に Spot Instance を利用してコスト削減を行うだけでなく、Node 終了時に Pod が安全に退避し、  
アプリケーションが Graceful Shutdown できる構成を実装・検証することを目的とする  

---

## アーキテクチャ

```text
AWS Spot Interruption
（または Rebalance Recommendation）
↓
EventBridge
↓
Node Termination Handler
↓
Node Drain
↓
Pod Eviction
↓
Pod Disruption Budget
（最低1Podを維持）
↓
別 Node へ Pod を再スケジュール
↓
Application Graceful Shutdown
```
---

## 実装した主要機能

### Node Termination Handler (NTH)

Spot Instance の終了通知および Rebalance Recommendation を検知し、対象 Node を Drain する  

#### 必要な理由

Spot Instance は AWS 都合でいつでも終了する可能性がある  

NTH が存在しない場合、Node 上の Pod は突然消失し、
アプリケーションが正常終了処理を実行できない  

---

### Pod Disruption Budget (PDB)

Pod の最低稼働台数を保証する  

```yaml
minAvailable: 1 
```

#### 必要な理由

Node Drain 時に全 Pod が同時に退避されることを防ぐ  

最低 1Pod を維持することでサービス停止を防止する  

---

### Topology Spread Constraints

Pod を複数 Node へ分散配置する  

#### 必要な理由

複数 Pod が同一 Node に集中すると、Node 障害時に全 Pod が同時消失する  

Node 間に均等配置することで、単一 Node 障害への耐性を向上させる  

---

## 検証内容

### Pod 分散確認

Topology Spread Constraints により、Pod が複数 Node へ分散配置されることを確認  
```text
NAME                             READY   STATUS    RESTARTS   AGE    IP             NODE
spot-test-app-65669c4b6d-89f7b   1/1     Running   0          108s   10.0.209.38    ip-10-0-247-62.ap-northeast-1.compute.internal
spot-test-app-65669c4b6d-xtz5x   1/1     Running   0          119s   10.0.150.225   ip-10-0-151-205.ap-northeast-1.compute.internal
```

### Drain 確認

手動 Drain により Pod が別 Node へ再配置されることを確認  

### PDB 確認

PDB によって最低 1Pod が維持されることを確認  

一度に全ての Pod を終了させようとすると、  
以下のメッセージと共に最後の Pod 停止が拒否されることを確認した  

```text
Cannot evict pod as it would violate the pod's disruption budget 
```

### ログ分析基盤

EKS、Kubernetes 内の状況を監視・分析するために、  
以下の機能を用いたログ分析基盤を構築した  

- Kubernetes Event Exporter
- CloudWatch Logs
- EventBridge
- SNS 通知（Rebalance Recommendation / Interruption Notice）
- Logs Insights クエリ集

---

## 学んだこと

**Spot 運用は単一機能では成立しない**  

以下の機能を組み合わせることで、初めて安全な運用が可能となる  

- Node Termination Handler
- Pod Disruption Budget
- Topology Spread Constraints

特に Replicas、PDB、Topology Spread Constraints は補完関係にあり、  
どれか一つだけ有効にしても Spot 運用における可用性は十分ではない  

---

## 今後の改善案

- 実際のSpot終了イベント観測
- Rebalance Recommendation観測
- Karpenterへの移行検証
- CloudWatch Dashboard整備
- 運用Runbook作成

---

## 結論

Spot Instance の安全な運用は、  
単一機能ではなく複数の Kubernetes 機能を組み合わせることで実現される  

本プロジェクトでは、  

- Node Termination Handler
- Pod Disruption Budget
- Topology Spread Constraints

を組み合わせることで、  
Spot Instance 終了時に Pod が安全に退避し、  
アプリケーションが Graceful Shutdown できる基盤を構築・検証した  
