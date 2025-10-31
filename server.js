import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
const upload = multer();

// 브라우저에서 오는 요청(CORS) 허용
app.use(cors({ origin: "*" }));

// 🔐 Dropbox 액세스 토큰 (Bearer 포함, 한 줄 그대로!)
const DROPBOX_TOKEN =
  "Bearer sl.u.AGETpn391W2nwklxtA8oo41Gnatvu3sPidlLCA1zA9sey13ED_RlgxygVckdBIbQbl1veL0YxaGh-3Pk66U1uFCuwm-LHVqw_ERrvjVHNCHXE3LUeYKwLDzFxaPSubFVJZD3DafBresjaqFF87w5_3CwlOioun-DOqLdfnDTPzDlnH_FBt0Gnq3Z2vIWU1opWwXtKT9WPO2ihkqpotRR8TIBN6-2GEm3aFKnxOuviJx8M2yAKD_HTZghI2PylOq6MEfAG-aRV52SBsIH5a6ge7epqR_5w_ReJL_FSrkAFQv9vrwn4pO_jD3LIbSN3JCbPn1nUOSBjnhRvn4GJ7846e291h2f2C-ibdPer23H0CUNXdBJyP4qoGI5uSo-sdZmXb8fvsY9kFgAQEpL-Bx65EqGnZOrD-DUoPga3ulTHY4V-K7O97Gy1M0yCffy-PUNEqN0FVEwrfX1pXUm2ycekmwSdxpfjSXTZmel0CrcawFVQWAo8TYtZ0BtxNarnxOrwoEkIxqabjM8ge3J8kigZSuxyb3hSBAL35_BOQTbpPyr8p9qiSj4iWKkrxTk8M0joNozcMPm_9qOhIWktoHNplFeP3bYIAd7YOVbEsHDllwRMHVCnwXwXTN6gLLFK11G0ujTgHX4NsS4RQZQ-UM3X0WE35KSnJ0wRgfpHsl7LyAMol1V_wXDF0Otebe-BkKwJMNdzbUZrCzkh3aBGKiqoTWvCRtodYEtgOF5ymJW5BYyxfc5luvMvKkf5z2xaZ7V3keX6XRYtNmi9zcllk-WHmCioS1N-K3xtQlMhJMkyk__WY_BXGDkt4rWMKARLFqNjrTb7AATZ5clpUrwlaKwP7TTa1rlFpZ3MsphUiPRnHMfA5rwDYVM1I6nps3AFTwvoFbq_nxKxg1rwK7HCRXSA9EcV6rMwQIx6oXGEjQHaaH38tz4rWaSHW7o3QGL-lS3M7QQZAF_PhcborCZ0ItWz5S9x6mRX6oJnmFuVTZhjK5WVcitsE2C6EFYxH3wIIwGVZf1t2xUmAXOmObHygd5LIdEDzqPHddjbhwApJHfl-eNcEfqY06bVz9wnKH57tLlIeWtwW-5gz0hO-zA31F0KF0oUh3s_kzq0nlLKee8QDfPIKn-hgrVYiIEwT9LjMXCLokdI2A-Rh-L34lA9r3XhiN9Dn0Mi8A8iIKtb8RfopZbMbXqhRm3c1melFyzhFxUxU-F_gRz6hzblfOvTj5JZhl61CWza4hch3woH5n2ClLqVabUSq1A3dOg8jUtC6tuRnbTpR4yqOjlpbRM_nWCCHPVop0eMSoSrzdeddP5g1hBA4ZPnnJBUTP3f8Ctc5xcMbGpEV_6x9oPThphvnl7mlomandSqHwSJRnenhnVfBB4SfcDcSZy0HUzyDU-whRhpWoNKTlGixG5j9VOqboWo2D1"; // 예: "Bearer sl.u.AGGuzC_...."

app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    const file = req.file;
    const rawName = req.body.name || "user";

    if (!file) {
      return res.status(400).json({
        ok: false,
        message: "파일 없음",
      });
    }

    // 업로드 파일명: 닉네임_타임스탬프.png
    const safeName = rawName.replace(/[^a-zA-Z0-9가-힣_-]/g, "_");
    const filename = `${safeName}_${Date.now()}.png`;

    // Dropbox에 저장할 경로 (한 단계 폴더만 사용해서 에러 확률 낮춤)
    const dropboxArg = {
      path: `/booth_uploads/${filename}`,
      mode: "add",
      autorename: true,
      mute: false,
    };

    // Dropbox 업로드 API 호출
    const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        Authorization: DROPBOX_TOKEN,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify(dropboxArg),
      },
      body: file.buffer,
    });

    // Dropbox 응답 검사
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("🚨 Dropbox upload error:", errText);

      return res.status(500).json({
        ok: false,
        message: "Dropbox 업로드 실패",
        detail: errText,
      });
    }

    const result = await resp.json();

    // 성공 응답
    return res.json({
      ok: true,
      path: result.path_display || result.path_lower || filename,
    });
  } catch (err) {
    console.error("🚨 SERVER ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: "서버 내부 오류",
      detail: String(err),
    });
  }
});

// Render 기본 포트 처리
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});

