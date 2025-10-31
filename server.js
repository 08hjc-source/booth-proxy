import express from "express";
import cors from "cors";
import multer from "multer";

// Render(Node 22 이상)는 fetch가 글로벌로 이미 있음.
// node-fetch 안 써도 됨. (node-fetch 섞이면 import 충돌날 수 있음)

const app = express();

// CORS 허용 (모든 origin 허용. 부스용이라 상관없다고 했으니까 이렇게 간다)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// preflight OPTIONS 직접 처리 (브라우저가 전송 전에 OPTIONS 보내는 경우 대비)
app.options("/upload", (req, res) => {
  res.sendStatus(200);
});

// multer: multipart/form-data 파서
const upload = multer();

// 🔐 Dropbox 토큰 (Bearer 포함해서 한 줄 그대로 넣어)
const DROPBOX_TOKEN =
  "Bearer sl.u.AGETpn391W2nwklxtA8oo41Gnatvu3sPidlLCA1zA9sey13ED_RlgxygVckdBIbQbl1veL0YxaGh-3Pk66U1uFCuwm-LHVqw_ERrvjVHNCHXE3LUeYKwLDzFxaPSubFVJZD3DafBresjaqFF87w5_3CwlOioun-DOqLdfnDTPzDlnH_FBt0Gnq3Z2vIWU1opWwXtKT9WPO2ihkqpotRR8TIBN6-2GEm3aFKnxOuviJx8M2yAKD_HTZghI2PylOq6MEfAG-aRV52SBsIH5a6ge7epqR_5w_ReJL_FSrkAFQv9vrwn4pO_jD3LIbSN3JCbPn1nUOSBjnhRvn4GJ7846e291h2f2C-ibdPer23H0CUNXdBJyP4qoGI5uSo-sdZmXb8fvsY9kFgAQEpL-Bx65EqGnZOrD-DUoPga3ulTHY4V-K7O97Gy1M0yCffy-PUNEqN0FVEwrfX1pXUm2ycekmwSdxpfjSXTZmel0CrcawFVQWAo8TYtZ0BtxNarnxOrwoEkIxqabjM8ge3J8kigZSuxyb3hSBAL35_BOQTbpPyr8p9qiSj4iWKkrxTk8M0joNozcMPm_9qOhIWktoHNplFeP3bYIAd7YOVbEsHDllwRMHVCnwXwXTN6gLLFK11G0ujTgHX4NsS4RQZQ-UM3X0WE35KSnJ0wRgfpHsl7LyAMol1V_wXDF0Otebe-BkKwJMNdzbUZrCzkh3aBGKiqoTWvCRtodYEtgOF5ymJW5BYyxfc5luvMvKkf5z2xaZ7V3keX6XRYtNmi9zcllk-WHmCioS1N-K3xtQlMhJMkyk__WY_BXGDkt4rWMKARLFqNjrTb7AATZ5clpUrwlaKwP7TTa1rlFpZ3MsphUiPRnHMfA5rwDYVM1I6nps3AFTwvoFbq_nxKxg1rwK7HCRXSA9EcV6rMwQIx6oXGEjQHaaH38tz4rWaSHW7o3QGL-lS3M7QQZAF_PhcborCZ0ItWz5S9x6mRX6oJnmFuVTZhjK5WVcitsE2C6EFYxH3wIIwGVZf1t2xUmAXOmObHygd5LIdEDzqPHddjbhwApJHfl-eNcEfqY06bVz9wnKH57tLlIeWtwW-5gz0hO-zA31F0KF0oUh3s_kzq0nlLKee8QDfPIKn-hgrVYiIEwT9LjMXCLokdI2A-Rh-L34lA9r3XhiN9Dn0Mi8A8iIKtb8RfopZbMbXqhRm3c1melFyzhFxUxU-F_gRz6hzblfOvTj5JZhl61CWza4hch3woH5n2ClLqVabUSq1A3dOg8jUtC6tuRnbTpR4yqOjlpbRM_nWCCHPVop0eMSoSrzdeddP5g1hBA4ZPnnJBUTP3f8Ctc5xcMbGpEV_6x9oPThphvnl7mlomandSqHwSJRnenhnVfBB4SfcDcSZy0HUzyDU-whRhpWoNKTlGixG5j9VOqboWo2D1";

// 위험문자만 제거하고, 한글/영문/숫자/언더바/하이픈은 살림
function makeSafeName(raw) {
  if (!raw) return "user";
  return raw
    .trim()
    // Dropbox path에서 문제 될 수 있는 예약문자들만 제거
    .replace(/[\/\\:\*\?"<>\|]/g, "")
    // 공백은 _ 로
    .replace(/\s+/g, "_");
}

app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    // 1) 파일 확인
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        message: "no file buffer",
        debug: "req.file or req.file.buffer is missing",
      });
    }

    const fileBuffer = req.file.buffer;

    // 2) 이름(닉네임) 확인
    // multer는 multipart/form-data 안의 text 필드(req.body.xxx)도 파싱해줘야 정상이다.
    // 그런데 환경 따라 인코딩 문제로 undefined가 될 수도 있으니 fallback 처리한다.
    const rawName = req.body && typeof req.body.name === "string" ? req.body.name : "";
    console.log("받은 이름(raw):", rawName);

    const safeName = makeSafeName(rawName || "user");
    console.log("정제된 이름(safeName):", safeName);

    // 3) Dropbox에 저장될 경로 (한글 포함 가능)
    const dropboxPath = `/booth_uploads/${safeName}_${Date.now()}.png`;
    console.log("업로드 경로:", dropboxPath);

    // 4) Dropbox 업로드 요청
    // Node 22+ 에서는 fetch 전역지원
    const dropResp = await fetch("https://content.dropboxapi.com/2/files/upload", {
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
    });

    const dropData = await dropResp.json();
    console.log("Dropbox 응답:", dropData);

    if (!dropResp.ok) {
      // Dropbox 쪽에서 실패한 경우
      return res.status(500).json({
        ok: false,
        message: "dropbox upload failed",
        dropbox_error: dropData,
      });
    }

    // 성공
    return res.json({
      ok: true,
      path: dropData.path_display || dropboxPath,
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

// Render 기본 포트 대응
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port " + port);
});
