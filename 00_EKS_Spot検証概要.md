# EKS Spot インスタンス継続性検証 概要

- [EKS Spot インスタンス継続性検証 概要](#eks-spot-インスタンス継続性検証-概要)
- [目的](#目的)
- [前提](#前提)
- [評価ポイント](#評価ポイント)
- [監視方法](#監視方法)
- [検証構成](#検証構成)
- [検証期間](#検証期間)

---

# 目的
EKS のコスト削減をするために、Workload を On-Demand instance から 
Spot instance に移行するにあたり、
Spot Node や Pod を安定稼働することができるか検証する  

実際に EKS Cluster、Spot NodeGroup を起動し、ステータスを監視・評価する検証を行う  

---

# 前提
- アプリの処理内容や Spot 適正の有無は当検証では考慮しない (実験用アプリを使用)
- CFn の LaunchTemplate、NodeGroup で Spot NodeGroup を作成する
- アプリ側は Workload の nodeSelector、toleration を使用し Spot Node に Pod をデプロイする
- 必要最低限のシンプルなインフラ構成で検証を進める
- ログやドキュメントなど、検証のエビデンスとなる情報は収集する

---

# 評価ポイント
安定稼働の評価軸として以下を確認する  
## Spot の生存時間（起動から終了までの時間）
  - 「どのくらいの頻度で instance が落ちるか」を確認する基本指標、インスタンスごとの寿命分布を出す
## Spot 終了後、代替 instance が確保されるまでの待機時間
  - Spot interruption 発生 → 新しい Node が Ready になるまでの時間
  - 「NodeGroup が機能を維持できるか」を確認する指標
## Spot 終了後、Node が Ready になるまでの時間
  - 代替 instance が EC2 上で起動するタイミングと、K8s 的に Ready になるタイミングにズレがあるため要確認
  - EKS は replacement Spot node が Ready になったら cordon/drain を進めるため、両タイミングの計測が必要
## Spot 終了後、Pod が再起動するまでの時間（アプリ停止時間）
  - 場合によっては Pod の eviction が間に合わず、強制終了する可能性もあるので要確認
  - Pod が再起動するまでの時間は 2つに分解して計測する
    - ① Pod Terminated → Pod Scheduled
    - ② Pod Scheduled → Pod Ready
    - ① が遅いと Spot Node 不足、② が遅いとアプリ側の問題に原因の切り分けができる
## Pod の再スケジューリング成功率
  - Node が停止した後、Pod が別 Node へ再配置されたかを確認する
## Capacity Rebalancing の発生タイミングと interruption notice との差
  - interruption notice (Spot終了2分前通知) よりどれだけ前に rebalance recommendation が来るかの分布を出す
## Node と Pod 再配置の質 (drain 時に Node と アプリ が正常終了、再配置できたか)
  - terminationGracePeriodSeconds、preStop、readiness の外れ方、PDB の影響で Pod の停止方法が変わるため要確認
  - AWS も Pod Disruption Budgets と proper termination handling を推奨している
  - 可能なら以下のような失敗ケースを監視する
    - pod terminated から 一定時間以内に pod scheduled が発生せず、Pending のままになるケースを再スケジュール失敗としてカウントする
    - NodeGroup が desired capacity を満たせないケース
      - interruption notice から 一定時間以内に instance launch が発生しないケースをキャパシティ不足としてカウントする
## On-Demand との コスト削減金額
基本的に 60 ~ 80 % の削減となるが、具体的な数値を計算する
  - 同一 workload を On-Demand で実行した場合の想定コストを算出し、Spot 実績コストとの差分を求める
  - interruption による再起動コスト（ロス時間）も考慮する

---

# 監視方法
CloudWatch Logs + Container Insights + EventBridge を中心に Node、Pod を監視する
- CloudWatch Container Insights は EKS / Kubernetes のメトリクスを ContainerInsights namespace に出力し、
Node / Pod の CPU, Mem, pod restart などを確認できる　　

監視すべき観点は以下の 3つ
## ① EC2/Spot 側のイベント
- rebalance recommendation
- interruption notice
- instance 起動 / 終了
## ② Kubernetes 側のイベント
- node NotReady / Ready
- pod eviction
- pod Pending / Running / Ready
- container restart
## ③　時刻差分を集計するための証跡
- それぞれのイベントタイムスタンプを1か所に集約

---

CloudWatch / Container Insights で監視すべきメトリクスは以下
## Node 系
Spot が終了する前後のリソース使用状況の逼迫度を確認する  
- node_cpu_utilization
- node_memory_utilization
- node_filesystem_utilization
- node_number_of_running_pods
- node_number_of_running_containers

## Pod 系
Pod の再起動や不安定さを確認する  
- pod_cpu_utilization
- pod_number_of_container_restarts

## Service/Cluster の補助指標
期待される Pod 数に戻るまでの時間を確認する
- service_number_of_running_pods

---

今回の目的では、定常メトリクスよりもイベントログの時刻差分に着目する

## EC2/EventBridge
- EC2 Instance Rebalance Recommendation
- Spot interruption notice
- 
## Kubernetes
- Node Ready / NotReady
- Pod Killing
- Pod Scheduled
- Container Started
- Readiness probe success
- Eviction イベント

---

これらを CloudWatch Logs に集約すれば、以下の差分を出せる  

- rebalance recommendation → interruption notice
- interruption notice → node drain start
    - node drain start は Kubernetes Event（Node cordon / Pod eviction 開始）から取得する
- pod terminated → replacement pod scheduled
- replacement pod scheduled → pod Ready
- instance launch → node Ready

---

# 検証構成
検証では NodeGroup 2台構成とする  

## ① On-Demand の 最小 NodeGroup
CoreDNS、aws-node、監視系など、cluster を維持するシステムを稼働するための NodeGroup  
- desired=1, min=1, max=1

## ② Spot 専用 NodeGroup
検証対象の workload を配置する NodeGroup
- desired=2, min=1, max=2 or 3
- Spot NodeGroup は複数 AZ にまたがるように構成する

## 検証用 workload
軽量の HTTP サーバを以下の設定で動作させる  
- replicas=2 or 3
- nodeSelector / toleration でデプロイ先を Spot Node に限定
- readiness / liveness probe あり
- 起動時刻をログ出力
- shutdown hook で終了時刻をログ出力

instance type は同一 vCPU / Memory 帯で揃えることで、Pod のスケジューリング特性を一定に保つ  
複数 instance type を指定することで Spot capacity pool を分散し、安定性を評価する  
今回使用する type は以下  (2 vCPU / 4 GiB 帯)  
- t3.medium
- t3a.medium
- m5.large
- m5a.large
- m5n.large
- m4.large

---

# 検証期間
Spot は日や時間帯のリアルタイムな空きキャパシティに影響されるので、期間に幅を持たせる
## Phase 1 (7日)
- 監視、ログ、時刻差分の仕組みづくり
- Spot interruption / rebalance の計測
- 計測ロジックと可視化の整備

## Phase 2 (必要に応じて 14~21日)
- 日別、時間帯別の傾向確認
- instance type 候補数の影響確認
- NodeGroup 構成差の比較

---
