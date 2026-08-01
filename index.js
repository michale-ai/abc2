require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const HttpsProxyAgent = require('https-proxy-agent'); 

const app = express();
const port = process.env.PORT || 3000;

let PROXIES = [];
try {
    if (process.env.PROXY_LIST) {
        PROXIES = JSON.parse(process.env.PROXY_LIST);
        console.log(`✅ Loaded ${PROXIES.length} proxies.`);
    }
} catch (e) {
    console.error("❌ Proxy list parse error:", e.message);
}

// 공통 헤더 (브라우저 위장)
const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json'
};

async function fetchWithFallback(url) {
    // 1. 먼저 프록시들을 사용하여 시도 (최대 3회)
    for (let i = 0; i < 3; i++) {
        if (PROXIES.length === 0) break; // 프록시 없으면 바로 직접 연결로 이동

        const proxyUrl = PROXIES[Math.floor(Math.random() * PROXIES.length)];
        const agent = new HttpsProxyAgent(proxyUrl);
        
        try {
            // console.log(`🔄 Attempt ${i+1} via proxy...`);
            const response = await fetch(url, {
                agent: agent,
                headers: COMMON_HEADERS,
                timeout: 3000 // 3초 타임아웃
            });

            if (response.status === 200) return response; // 성공 시 반환
            // 429나 403이면 다음 프록시 시도

        } catch (err) {
            // 실패 시 무시하고 다음 루프
        }
    }

    // 2. 모든 프록시가 실패하면 '직접 연결(Direct)' 시도 (최후의 수단)
    console.log("⚠️ All proxies failed. Trying DIRECT connection...");
    const directResponse = await fetch(url, {
        headers: COMMON_HEADERS,
        timeout: 5000
    });

    if (!directResponse.ok) {
        throw new Error(`Direct connection failed with status: ${directResponse.status}`);
    }
    return directResponse;
}

app.get('/', async (req, res) => {
    const assetId = req.query.id;
    
    // [중요] Lua에서 요청이 들어왔는지 확인하는 로그
    console.log(`📥 Request for ID: ${assetId}`);

    if (!assetId) return res.status(400).json({ error: "Missing 'id'" });

    const targetUrl = `https://catalog.roblox.com/v1/assets/${assetId}/bundles`;

    try {
        const response = await fetchWithFallback(targetUrl);
        const data = await response.json();

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.status(200).json(data);

    } catch (err) {
        console.error(`❌ Final Error for ${assetId}:`, err.message);
        // 500을 보내야 Lua가 429로 착각해서 멈추지 않고, 재시도 로직을 탈 수 있음
        res.status(500).json({ error: "Fetch Failed", details: err.message });
    }
});

app.get('/ping', (req, res) => res.send('pong'));

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
