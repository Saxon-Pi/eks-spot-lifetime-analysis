# 手動 drain 時の復旧時間測定

## 概要

以下の Pod 状況で、  
片側 Node を drain した際の Pod 復旧時間を測定する  

今回は手動だが、  
NTH が Rebalance Recommendation や Spot 終了通知を受けて  
drain 開始してから、Pod が復旧する時間を擬似的に計測している  

また、  

- SIGTERM による Graceful Shutdown
- Readiness Probe による切り離し
- 別 Node への Pod 再配置

が期待通り動作することも合わせて確認する  

---

旧Pod 状況  

```text
kubectl get pods -n spot-test -o wide           
NAME                             READY   STATUS    RESTARTS   AGE     IP             NODE                                              NOMINATED NODE   READINESS GATES
spot-test-app-65669c4b6d-tfkvb   1/1     Running   0          2d17h   10.0.169.142   ip-10-0-151-205.ap-northeast-1.compute.internal   <none>           <none>
spot-test-app-65669c4b6d-v4ppk   1/1     Running   0          2d17h   10.0.237.219   ip-10-0-247-62.ap-northeast-1.compute.internal    <none>           <none>
```

Node drain 実行  

```bash
kubectl drain ip-10-0-151-205.ap-northeast-1.compute.internal \
  --ignore-daemonsets \
  --delete-emptydir-data
```

新Pod 状況  

```text
kubectl get pods -n spot-test -o wide 
NAME                             READY   STATUS    RESTARTS   AGE     IP             NODE                                             NOMINATED NODE   READINESS GATES
spot-test-app-65669c4b6d-tmmgw   1/1     Running   0          23m     10.0.244.1     ip-10-0-247-62.ap-northeast-1.compute.internal   <none>           <none>
spot-test-app-65669c4b6d-v4ppk   1/1     Running   0          2d18h   10.0.237.219   ip-10-0-247-62.ap-northeast-1.compute.internal   <none>           <none>
```

uncordon

```bash
kubectl uncordon ip-10-0-151-205.ap-northeast-1.compute.internal
```

---

## Logs Insightsクエリ

```sql
fields @timestamp,
       kubernetes.pod_name,
       kubernetes.host,
       log_processed.event,
       log
| filter kubernetes.namespace_name = "spot-test"
| filter kubernetes.pod_name in [
  "spot-test-app-65669c4b6d-tfkvb",
  "spot-test-app-65669c4b6d-tmmgw"
]
| filter ispresent(log_processed.event)
   or log like /readyz/
   or log like /healthz/
| sort @timestamp asc
| limit 200
```

---

## 実行結果

2026-06-13T02:06:26.649Z  
新Pod application_started  

```log
{
  "event": "application_started",
  "timestamp": "2026-06-13T02:06:26.649003+00:00",
  "pod_name": "spot-test-app-65669c4b6d-tmmgw",
  "namespace": "spot-test",
  "node_name": "ip-10-0-247-62.ap-northeast-1.compute.internal",
  "app": "eks-spot-lifetime-test-app"
}
```

2026-06-13T02:06:27.704Z  
旧Pod SIGTERM受信 / shutdown開始  

```log
{
  "event": "application_sigterm_received",
  "timestamp": "2026-06-13T02:06:27.703873+00:00",
  "pod_name": "spot-test-app-65669c4b6d-tfkvb",
  "namespace": "spot-test",
  "node_name": "ip-10-0-151-205.ap-northeast-1.compute.internal",
  "app": "eks-spot-lifetime-test-app",
  "signal": 15
}
```

```log
{
  "event": "application_shutdown_started",
  "timestamp": "2026-06-13T02:06:27.703982+00:00",
  "pod_name": "spot-test-app-65669c4b6d-tfkvb",
  "namespace": "spot-test",
  "node_name": "ip-10-0-151-205.ap-northeast-1.compute.internal",
  "app": "eks-spot-lifetime-test-app"
}
```

2026-06-13T02:06:28.211Z  
新Pod readiness 200 OK  

```log
{
  "time": "2026-06-13T02:06:28.209965614Z",
  "stream": "stdout",
  "_p": "F",
  "log": "INFO:     10.0.247.62:60388 - \"GET /healthz HTTP/1.1\" 200 OK",
  "kubernetes": {
    "pod_name": "spot-test-app-65669c4b6d-tmmgw",
    "namespace_name": "spot-test",
    "pod_id": "2c4a0828-6571-4e01-8c00-5c90b7660463",
    "host": "ip-10-0-247-62.ap-northeast-1.compute.internal",
    "pod_ip": "10.0.244.1",
    "container_name": "spot-test-app",
    "docker_id": "e7797ea546366064445ae005323f150a84c92b10c9a531040f11aaf162f09695",
    "container_hash": "867344446779.dkr.ecr.ap-northeast-1.amazonaws.com/spot-test-app@sha256:ce5948e87dfc332db358343b6750ac86d683e795ea2fbd471f0f291196343c9f",
    "container_image": "867344446779.dkr.ecr.ap-northeast-1.amazonaws.com/spot-test-app:latest"
  }
}
```

```log
{
  "time": "2026-06-13T02:06:28.21131623Z",
  "stream": "stdout",
  "_p": "F",
  "log": "INFO:     10.0.247.62:60390 - \"GET /readyz HTTP/1.1\" 200 OK",
  "kubernetes": {
    "pod_name": "spot-test-app-65669c4b6d-tmmgw",
    "namespace_name": "spot-test",
    "pod_id": "2c4a0828-6571-4e01-8c00-5c90b7660463",
    "host": "ip-10-0-247-62.ap-northeast-1.compute.internal",
    "pod_ip": "10.0.244.1",
    "container_name": "spot-test-app",
    "docker_id": "e7797ea546366064445ae005323f150a84c92b10c9a531040f11aaf162f09695",
    "container_hash": "867344446779.dkr.ecr.ap-northeast-1.amazonaws.com/spot-test-app@sha256:ce5948e87dfc332db358343b6750ac86d683e795ea2fbd471f0f291196343c9f",
    "container_image": "867344446779.dkr.ecr.ap-northeast-1.amazonaws.com/spot-test-app:latest"
  }
}
```

2026-06-13T02:06:29.343Z  
旧Pod readiness 503  

```log
{
  "time": "2026-06-13T02:06:29.342938604Z",
  "stream": "stdout",
  "_p": "F",
  "log": "INFO:     10.0.151.205:41300 - \"GET /readyz HTTP/1.1\" 503 Service Unavailable",
  "kubernetes": {
    "pod_name": "spot-test-app-65669c4b6d-tfkvb",
    "namespace_name": "spot-test",
    "pod_id": "af84d115-2e9a-4d69-b3e9-318fcd5f3932",
    "host": "ip-10-0-151-205.ap-northeast-1.compute.internal",
    "pod_ip": "10.0.169.142",
    "container_name": "spot-test-app",
    "docker_id": "ca2a5f8099044a91e9d29b98d7ef20e49e49d7a36c590f4f77c322159c391ffa",
    "container_hash": "867344446779.dkr.ecr.ap-northeast-1.amazonaws.com/spot-test-app@sha256:ce5948e87dfc332db358343b6750ac86d683e795ea2fbd471f0f291196343c9f",
    "container_image": "867344446779.dkr.ecr.ap-northeast-1.amazonaws.com/spot-test-app:latest"
  }
}
```

---

## 結論

Node drain 開始後、  

- 新Pod起動
- Ready化
- 旧PodのGraceful Shutdown

が約3秒以内で完了した  

Spot Interruption Notice の猶予時間  
(約2分) と比較すると十分な余裕があり、  

今回の構成では Spot 終了時にも  
サービス継続が可能であることを確認できた  

```text
新Pod application_started から readiness OK まで：約1.56秒
旧Pod SIGTERM受信から旧Pod NotReadyまで：約1.64秒
旧Pod SIGTERM受信時点では、すでに新Podは起動済み
```

---

### 補足

コンテナ起動(application_started)と  
サービス利用可能状態(Ready)は異なる  

Kubernetes Service は Ready 状態の Pod のみを  
トラフィック対象とするため、  

```text
application_started
↓
readiness 200
↓
Service組み込み
```

の順で処理される

今回の検証では、  
旧PodがServiceから切り離される前に、
新PodがReadyになっていることを確認できた

---
