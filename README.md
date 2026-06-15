# arko-2api

- [Arko Studio](https://arko.arcaelas.com) 的 agent API 轉換為 OpenAI 相容格式的 API 服務。
- 有管理介面，可以設定多個 agent uuid 自動輪詢。
- 有 playground 可以測試對話、圖片生成，有 markdown 渲染。

## 前置

- Arko 帳號，建立 API Key，取得 agent UUID。
- Cloudflare 帳號（非必要）。

## 本地測試

本地運行使用 `wrangler.toml` 中的 `[[d1_databases]]` 設定，或參考 `wrangler.toml.example`。

```bash
# 安裝依賴
npm install

npm run dev
```

## 部署

```bash
# 設定 D1 資料庫
npx wrangler d1 create arko-2api-db
# 將輸出的 database_id 填入 wrangler.toml

# 部署
npx wrangler deploy
```

### 測試連線

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai",
    "messages": [{"role": "user", "content": "Hello"}],
    "tools": [{"type": "function", "function": {
      "name": "search",
      "description": "Search the web",
      "parameters": {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"]
      }
    }}]
  }'
```

### 定時清除舊對話

`/health` 路由會自動將所有 agent 刪除今日之前的所有對話，可透過 cronjob 定時每小時觸發。
