"""
# 目的
以下を JSON ログで残すアプリ

- PodがどのNodeで起動したか
- Podがいつ起動したか
- Podがいつ終了命令を受けたか

Spot Node 継続性検証を行うにあたり、必要な情報を収集している

# 全体構成
ローカル
↓
Docker build
↓
ECR
↓
Deployment
↓
Pod
↓
FastAPI アプリ起動
↓
CloudWatch Logs
"""

import json
import os
import signal
import sys
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.responses import JSONResponse

# Web サーバ作成
app = FastAPI()

is_shutting_down = False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

"""
Node と Pod 情報をログ出力する

アプリ起動時
→ application_started

SIGTERM受信時
→ application_sigterm_received (アプリ終了開始) 
→ application_shutdown_completed (終了処理完了 ※今のコードでは終了直前)
"""
def log_event(event: str, **kwargs) -> None:
    payload = {
        "event": event,
        "timestamp": now_iso(),
        "pod_name": os.getenv("POD_NAME"),
        "namespace": os.getenv("POD_NAMESPACE"),
        "node_name": os.getenv("NODE_NAME"),
        "app": "eks-spot-lifetime-test-app",
        **kwargs,
    }
    print(json.dumps(payload), flush=True)

# コンテナ起動 → アプリ起動 → startup
@app.on_event("startup")
def on_startup():
    log_event("application_started")

# ヘルスチェック (livenessProbe用)
# → コンテナを再起動すべきか？
@app.get("/healthz")
def healthz():
    return {"status": "ok"}

# リクエスト応答可否 (readinessProbe用)
# → リクエストを受けていいか？
@app.get("/readyz")
def readyz():
    if is_shutting_down:
        return JSONResponse(status_code=503, content={"status": "shutting_down"})
    return {"status": "ready"}


@app.get("/")
def root():
    return {"message": "hello from spot test app"}


def handle_sigterm(signum, frame):
    global is_shutting_down
    is_shutting_down = True

    log_event(
        "application_sigterm_received",
        signal=signum,
    )

    # preStop / terminationGracePeriodSeconds の観測用
    log_event("application_shutdown_completed")
    sys.exit(0)

# 終了命令が出たときに handle_sigterm 関数を実行
signal.signal(signal.SIGTERM, handle_sigterm)
