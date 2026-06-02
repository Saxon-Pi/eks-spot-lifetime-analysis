# EKS Spot検証 グラフ・ログ項目対応表

| No | グラフ / 集計 | 何が分かるか | 必要なログ項目 |
| --- | --- | --- | --- |
| 1 | Spot Instance 生存時間 | Spotがどのくらい安定して稼働するか | instance_id, instance_type, launch_time, terminated_time | 
| 2 | Rebalance → Interruption 時間 | Rebalanceがどの程度余裕を与えてくれるか | instance_id, rebalance_time, interruption_time | 
| 3 | Interruption → Node Ready 時間 | Capacity Rebalancingによる復旧速度 | instance_id, interruption_time, node_ready_time | 
| 4 | Instance Launch → Node Ready 時間 | EC2起動〜K8s利用可能までの時間 | instance_id, launch_time, node_ready_time | 
| 5 | Interruption → drain 開始時間 | Spot終了通知後にどれだけ早く退避開始できるか | interruption_time, drain_start_time | 
| 6 | Pod Terminated → Scheduled | Pod再配置待ち時間 | pod_name, terminated_time, scheduled_time | 
| 7 | Pod Scheduled → Ready | Pod起動時間 | pod_name, scheduled_time, ready_time |
| 8 | Pod Terminated → Ready | アプリ停止時間（最重要） | pod_name, terminated_time, ready_time |
| 9 | Pod再スケジューリング成功率 | Podが正常に再配置できたか | pod_name, terminated_time, scheduled_time | 
| 10 | Node復旧成功率 | replacement Nodeが起動できたか | interruption_time, instance_launch_time |
| 11 | Killing vs Evicted 比率 | graceful shutdownできているか | pod_name, event_type(Killing/Evicted)
| 12 | Node数・Pod数 時系列推移 | Spot終了時のシステム全体の挙動 | node_count, running_pod_count | 
| 13 | Node CPU/Memory 使用率 | interruption前後の負荷状況 | node_cpu_utilization, node_memory_utilization | 
| 14 | Pod Restart回数 | Podの安定性 | pod_number_of_container_restarts | 
| 15 | On-Demand vs Spot コスト比較 | コスト削減効果 | instance_type, runtime_hours, spot_cost, ondemand_cost |

# イベント単位で必要なログ一覧

| 種別 | イベント | 主な用途 |
| --- | --- | --- |
| EC2 | Rebalance Recommendation | Rebalance→Interruption |
| EC2 | Spot Interruption Notice | 全分析の起点 |
| EC2 | Instance Launch | Node復旧時間 | 
| EC2 | Instance Terminated | Spot寿命 | 
| K8s Node | Node Ready | Node復旧時間 | 
| K8s Node | Node NotReady | Node停止確認 | 
| K8s Node | Node Drain Start | Drain時間 | 
| K8s Pod | Killing | graceful shutdown確認 | 
| K8s Pod | Evicted | 強制終了確認 |
| K8s Pod | Scheduled | Pod再配置確認 | 
| K8s Pod | FailedScheduling | Pod再配置失敗確認 |
| K8s Pod | Started | Pod起動確認 |
| K8s Pod | Ready | アプリ復旧確認 | 

# 今回の検証で最終的に出したいグラフ

- Spot は何回落ちたか
- Rebalance はどれくらい役立ったか
- Node 復旧は何秒かかったか
- アプリ停止時間は何秒だったか
- 安全に終了できたか
- いくら安くなったか

| No | グラフ | 
| --- | --- |
| ① | Spot Instance 生存時間 | 
| ② | Rebalance → Interruption | 
| ③ | Interruption → Node Ready | 
| ④ | Pod Terminated → Ready | 
| ⑤ | Killing vs Evicted | 
| ⑥ | On-Demand vs Spot コスト比較 |

# ブログ記事用

優先度: 高  

| グラフ |記事で言えること |
| --- | --- |
| Pod Terminated → Ready | Spotでアプリ停止時間は何秒か |
| Rebalance → Interruption | Rebalanceは本当に役立つのか |
| Spot Instance 生存時間 | Spotはどれくらい落ちるのか |
| On-Demand vs Spot コスト比較 | 何％安くなったのか |

優先度: 中  

| グラフ |記事で言えること |
| --- | --- |
| Instance Launch → Node Ready | EKSの復旧速度 |
| Killing vs Evicted | graceful shutdown率 |
| Pod再スケジューリング成功率 | Spot運用可能か |

優先度: 低  

| グラフ | 記事で言えること |
| --- | --- |
| Node CPU/Memory推移 | 負荷との関連性 |
| Node数・Pod数推移 | Spot終了時の動き可視化 |
