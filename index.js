// index.js
require('dotenv').config(); // 로컬 테스트용 (.env 파일 로드)
const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const app = express();
const port = process.env.PORT || 3000;

// 1. 환경 변수에서 프록시 리스트를 가져와서 파싱 (없으면 빈 배열)
// Render 대시보드에서 이 변수 안에 JSON 문자열로 프록시를 넣을 것입니다.
let PROXIES = [];
try {
    if (process.env.PROXY_LIST) {
        PROXIES = JSON.parse(process.env.PROXY_LIST);
        console.log(`✅ Loaded ${PROXIES.length} proxies from environment variables.`);
    } else {
        console.warn("⚠️ No PROXY_LIST found in environment variables!");
    }
} catch (e) {
    console.error("❌ Failed to parse PROXY_LIST:", e.message);
}

// 2. 지능형 재시도(Smart Retry) 함수
async function fetchWithRetry(url, retries = 3) {
    let lastError;

    for (let i = 0; i < retries; i++) {
        // 프록시 리스트가 비어있으면 에러
        if (PROXIES.length === 0) throw new Error("No proxies available");

        // 랜덤 프록시 선택
        const proxyUrl = PROXIES[Math.floor(Math.random() * PROXIES.length)];
        const agent = new HttpsProxyAgent(proxyUrl);
        
        try {
            // console.log(`Attempt ${i+1}/${retries} using proxy...`); // 디버깅용 (필요시 주석 해제)
            
            const response = await fetch(url, {
                agent: agent,
                headers: { 
                    'User-Agent': 'RobloxGameServer/1.0',
                    'Accept': 'application/json'
                },
                timeout: 5000 // 5초 타임아웃 (응답 없으면 끊고 다음 프록시로)
            });

            // 429(Too Many Requests) 또는 500번대 서버 에러는 재시도 대상
            if (response.status === 429 || response.status >= 500) {
                throw new Error(`Bad Status: ${response.status}`);
            }

            return response; // 성공 시 결과 반환 (루프 종료)

        } catch (err) {
            console.warn(`⚠️ Attempt ${i + 1} failed: ${err.message}`);
            lastError = err;
            // 여기서 catch되면 루프가 돌아가며 다음 프록시를 시도합니다.
        }
    }
    
    // 모든 횟수(3회) 다 실패하면 에러를 던짐
    throw lastError;
}

// 3. 메인 라우트
app.get('/', async (req, res) => {
    const assetId = req.query.id;
    if (!assetId) return res.status(400).json({ error: "Missing 'id' parameter" });

    const targetUrl = `https://catalog.roblox.com/v1/assets/${assetId}/bundles`;

    try {
        // 재시도 로직을 통해 데이터 가져오기 (최대 3회 시도)
        const response = await fetchWithRetry(targetUrl, 3);
        const data = await response.text();

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Content-Type", "application/json");
        res.status(response.status).send(data);

    } catch (err) {
        console.error("❌ All proxies failed for ID:", assetId);
        res.status(500).json({ 
            error: "All Proxies Failed", 
            details: "Please try again later or check server logs." 
        });
    }
});

app.get('/ping', (req, res) => res.send('pong'));

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
