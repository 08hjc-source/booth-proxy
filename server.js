import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();

// CORS 설정 (전시장 현장 운영이라 널널하게 오픈)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// 프리플라이트(브라우저 사전 요청) 허용
app.options("/upload", (req, res) => {
  res.sendStatus(200);
});

// multipart/form-data 처리
const upload = multer();

// 🔐 Dropbox 토큰 (Bearer 포함해서 한 줄 그대로 복붙할 것)
const DROPBOX_TOKEN =
  "Bearer sl.u.AGETpn391W2nwklxtA8oo41Gnatvu3sPidlLCA1zA9sey13ED_RlgxygVckdBIbQbl1veL0YxaGh-3Pk66U1uFCuwm-LHVqw_ERrvjVHNCHXE3LUeYKwLDzFxaPSubFVJZD3DafBresjaqFF87w5_3CwlOioun-DOqLdfnDTPzDlnH_FBt0Gnq3Z2vIWU1opWwXtKT9WPO2ihkqpotRR8TIBN6-2GEm3aFKnxOuviJx8M2yAKD_HTZghI2PylOq6MEfAG-aRV52SBsIH5a6ge7epqR_5w_ReJL_FSrkAFQv9vrwn4pO_jD3LIbSN3JCbPn1nUOSBjnhRvn4GJ7846e291h2f2C-ibdPer23H0CUNXdBJyP4qoGI5uSo-sdZmXb8fvsY9kFgAQEpL-Bx65EqGnZOrD-DUoPga3ulTHY4V-K7O97Gy1M0yCffy-PUNEqN0FVEwrfX1pXUm2ycekmwSdxpfjSXTZmel0CrcawFVQWAo8TYtZ0BtxNarnxOrwoEkIxqabjM8ge3J8kigZSuxyb3hSBAL35_BOQTbpPyr8p9qiSj4iWKkrxTk8M0joNozcMPm_9qOhIWktoHNplFeP3bYIAd7YOVbEsHDllwRMHVCnwXwXTN6gLLFK11G0ujTgHX4NsS4RQZQ-UM3X0WE35KSnJ0wRgfpHsl7LyAMol1V_wXDF0Otebe-BkKwJMNdzbUZrCzkh3aBGKiqoTWvCRtodYEtgOF5ymJW5BYyxfc5luvMvKkf5z2xaZ7V3keX6XRYtNmi9zcllk-WHmCioS1N-K3xtQlMhJMkyk__WY_BXGDkt4rWMKARLFqNjrTb7AATZ5clpUrwlaKwP7TTa1rlFpZ3MsphUiPRnHMfA5rwDYVM1I6nps3AFTwvoFbq_nxKxg1rwK7HCRXSA9EcV6rMwQIx6oXGEjQHaaH38tz4rWaSHW7o3QGL-lS3M7QQZAF_PhcborCZ0ItWz5S9x6mRX6oJnmFuVTZhjK5WVcitsE2C6EFYxH3wIIwGVZf1t2xUmAXOmObHygd5LIdEDzqPHddjbhwApJHfl-eNcEfqY06bVz9wnKH57tLlIeWtwW-5gz0hO-zA31F0KF0oUh3s_kzq0nlLKee8QDfPIKn-hgrVYiIEwT9LjMXCLokdI2A-Rh-L34lA9r3XhiN9Dn0Mi8A8iIKtb8RfopZbMbXqhRm3c1melFyzhFxUxU-F_gRz6hzblfOvTj5JZhl61CWza4hch3woH5n2ClLqVabUSq1A3dOg8jUtC6tuRnbTpR4yqOjlpbRM_nWCCHPVop0eMSoSrzdeddP5g1hBA4ZPnnJBUTP3f8Ctc5xcMbGpEV_6x9oPThphvnl7mlomandSqHwSJRnenhnVfBB4SfcDcSZy0HUzyDU-whRhpWoNKTlGixG5j9VOqboWo2D1";

// 닉네임을 Dropbox용 ASCII 세이프 문자열로 변환
// - 한글 등 ASCII 아닌 문자는 제거
// - 공백 → _
// - 파일명에 못 쓰는 기호 제거
// - 다 지워져서 비면 "user"로 대체
function sanitizeAsciiFilename(userLabel) {
  const asciiOnly = (userLabel || "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "") // ASCII 외 전부 제거
    .replace(/[\/\\:\*\?"<>\|]/g, "") // 경로 깨는 문자 제거
    .replace(/\s+/g, "_") // 공백을 _
    .trim();

  return asciiOnly || "user";
}

// 한국시간(KST, UTC+9) 기준 HHMMSS 문자열 생성
function getKSTTimeTag() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC+9로 보정
  const hours = String(kst.getUTCHours()).padStart(2, "0");
  const mins = String(kst.getUTCMinutes()).padStart(2, "0");
  const secs = String(kst.getUTCSeconds()).padStart(2, "0");
  return `${hours}${mins}${secs}`; // 예: "134209"
}

app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    // 1) 파일 검사
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        message: "no file buffer",
        debug: "req.file or req.file.buffer is missing",
      });
    }

    const fileBuffer = req.file.buffer;

    // 2) 닉네임 추출 (한글 포함 그대로)
    const rawName =
      req.body && typeof req.body.name === "string" ? req.body.name : "";
    console.log("받은 이름(raw):", rawName);

    // 3) ASCII 파일명 생성
    const safeBase = sanitizeAsciiFilename(rawName); // ex) "chan" 또는 "user"
    const timeTag = getKSTTimeTag(); // ex) "134209"
    const finalFileName = `${safeBase}_${timeTag}.png`; // ex) "chan_134209.png"

    // 4) Dropbox 경로
    //    ⚠ 여기엔 ASCII만 들어가야 API가 안 터짐
    const dropboxPath = `/booth_uploads/${finalFileName}`;
    console.log("업로드 경로:", dropboxPath);

    // 5) Dropbox 업로드 호출
    // Node 22는 fetch 글로벌 지원, node-fetch 불필요
    const dropResp = await fetch(
      "https://content.dropboxapi.com/2/files/upload",
      {
        method: "POST",
        headers: {
          Authorization: DROPBOX_TOKEN,
          "Dropbox-API-Arg": JSON.stringify({
            path: dropboxPath,
            mode: "add",
            autorename: true,
            mute: false,
          }),
          "Content-Type": "application/octet-stream",
        },
        body: fileBuffer,
      }
    );

    const dropData = await dropResp.json();
    console.log("Dropbox 응답:", dropData);

    if (!dropResp.ok) {
      // Dropbox 자체에서 에러났을 때
      return res.status(500).json({
        ok: false,
        message: "dropbox upload failed",
        dropbox_error: dropData,
      });
    }

    // 6) 성공 응답
    //    - path: Dropbox에 실제로 저장된 경로 (ASCII 이름)
    //    - user: 실제 참여자 닉네임(한글 그대로) -> 프론트에서 안내용으로 쓸 수 있음
    return res.json({
      ok: true,
      path: dropData.path_display || dropboxPath,
      user: rawName,
      filename: finalFileName,
    });
  } catch (err) {
    console.error("서버 내부 오류:", err);
    return res.status(500).json({
      ok: false,
      message: "server crashed",
      error: String(err && err.message ? err.message : err),
    });
  }
});

// Render에서 자동으로 PORT를 넣어주기 때문에 그걸 우선 사용
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port " + port);
});
