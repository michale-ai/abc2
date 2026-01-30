// index.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const app = express();
const port = process.env.PORT || 3000;

// Render 환경 변수에서 프록시 리스트 불러오기
let PROXIES = [];
try {
    if (process.env.PROXY_LIST) {
        PROXIES = JSON.parse(process.env.PROXY_LIST);
        console.log(`✅ Loaded ${PROXIES.length} proxies.`);
    } else {
        console.warn("⚠️ No PROXY_LIST found!");
    }
} catch (e) {
    console.error("❌ Failed to parse PROXY_LIST:", e.message);
}

// 지능형 재시도 함수
async function fetchWithRetry(url, retries = 5) { // 재시도 횟수 3->5회로 증가
    let lastError;

    for (let i = 0; i < retries; i++) {
        if (PROXIES.length === 0) throw new Error("No proxies available");

        // 랜덤 프록시 선택
        const proxyUrl = PROXIES[Math.floor(Math.random() * PROXIES.length)];
        const agent = new HttpsProxyAgent(proxyUrl);
        
        try {
            const response = await fetch(url, {
                agent: agent,
                headers: { 
                    // 로블록스가 봇으로 의심하지 않도록 일반 크롬 브라우저인 척 위장
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json'
                },
                timeout: 5000 
            });

            // [핵심 수정] 404 에러도 "불량 프록시"로 간주하고 재시도하게 설정
            if (response.status === 429 || response.status === 403 || response.status === 404 || response.status >= 500) {
                throw new Error(`Bad Status: ${response.status}`);
            }

            return response; // 성공 시 반환

        } catch (err) {
            // 실패 시 로그만 남기고 다음 루프(다음 프록시)로 넘어감
            // console.log(`⚠️ Retry ${i+1}/${retries} failed: ${err.message}`);
            lastError = err;
        }
    }
    throw lastError; // 모든 시도 실패 시
}

app.get('/', async (req, res) => {
    const assetId = req.query.id;
    if (!assetId) return res.status(400).json({ error: "Missing 'id'" });

    const targetUrl = `https://catalog.roblox.com/v1/assets/${assetId}/bundles`;

    try {
        const response = await fetchWithRetry(targetUrl, 5); // 최대 5번까지 다른 프록시로 시도
        const data = await response.text();

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Content-Type", "application/json");
        res.status(200).send(data);

    } catch (err) {
        console.error(`❌ Final failure for ID ${assetId}:`, err.message);
        res.status(500).json({ error: "Proxy Failed", details: err.message });
    }
});

app.get('/ping', (req, res) => res.send('pong'));

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
