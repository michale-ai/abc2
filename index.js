const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// [필수] JSON 요청 본문을 파싱하기 위한 미들웨어 설정
app.use(express.json());

// Render 절전 방지용 핑 엔드포인트
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// ---------------------------------------------------------
// [신규] 배치(Batch) 처리 엔드포인트 (POST /batch)
// ---------------------------------------------------------
app.post('/batch', async (req, res) => {
  const assetIds = req.body.assetIds;

  // 1. 유효성 검사
  if (!assetIds || !Array.isArray(assetIds)) {
    return res.status(400).json({ error: "Invalid 'assetIds' in body" });
  }

  const results = {};

  // 2. 각 ID에 대해 병렬로 로블록스 API 요청 생성
  const tasks = assetIds.map(async (id) => {
    const robloxUrl = `https://catalog.roblox.com/v1/assets/${id}/bundles`;
    
    try {
      const response = await fetch(robloxUrl, {
        headers: {
          'User-Agent': 'RobloxGameServer/1.0',
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const json = await response.json();
        // 번들 데이터가 존재하면 첫 번째 번들 정보 추출
        if (json.data && json.data.length > 0) {
          const firstBundle = json.data[0];
          results[id] = {
            Id: firstBundle.id,
            Name: firstBundle.name,
            Description: firstBundle.description
          };
        } else {
          // 번들이 없는 경우
          results[id] = "NONE";
        }
      } else {
        // 로블록스 서버 에러 (429 등) -> null로 처리하여 클라이언트가 재시도하게 함
        console.warn(`Roblox API Error for ${id}: ${response.status}`);
        results[id] = null; 
      }
    } catch (err) {
      console.error(`Fetch Error for ${id}:`, err);
      results[id] = null;
    }
  });

  // 3. 모든 요청이 끝날 때까지 대기 (병렬 처리)
  await Promise.all(tasks);

  // 4. 결과 반환 { data: { "123": {...}, "456": "NONE" } }
  res.status(200).json({ data: results });
});

// ---------------------------------------------------------
// 기존 단일 조회 엔드포인트 (하위 호환성 유지)
// ---------------------------------------------------------
app.get('/', async (req, res) => {
  const assetId = req.query.id;

  if (!assetId) {
    return res.status(400).json({ error: "Missing 'id' parameter" });
  }

  const robloxUrl = `https://catalog.roblox.com/v1/assets/${assetId}/bundles`;

  try {
    const response = await fetch(robloxUrl, {
      headers: {
        'User-Agent': 'RobloxGameServer/1.0',
        'Accept': 'application/json'
      }
    });

    const data = await response.json(); // 텍스트 대신 JSON으로 바로 파싱

    // CORS 헤더 및 반환
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    res.status(response.status).json(data);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Proxy Fetch Failed", details: err.toString() });
  }
});

// 서버 실행
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});