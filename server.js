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
  "Bearer sl.u.AGGuzC_Aj7j91_ifSJzJ_XTeiyp0ny-eFp-CP58ImWGizvKTCvpAy5_vcCI9Q1ZvKpiEwmmwQFQ6gtQAQe7xNGvTPhXo3nrb4P9KDd2VOcs2QM0qPJn9Dtqc8yovEtoj7aJvnof81JWSTuUCUVJvb1WpuD7DqAFBbugbxYWCdTgT51Z7tvrY83ttu6sm98mckzzP7hYY3i5A5HBd6qv7U25sJbEpvv35yunYokrRinyNqcB2khQzLDyWdOwdpUZhVJwfqlopjJoFGKWuB2Fqz7OMvm7Z8MdCXnHgTmH2zpRB3Jfp6RICVBtbD2xhbTOjpMHp_C7XGZ2c3ZOj28FKVTX632F4dmZ6TatZGcLYedrmNxr-pWCnejKoJdlnrGvRgS0U_UtRd3Y8CVThL-5iyF7CFbO5fK0KHcl-dPw8iK8cp6-PxsYt0O-o3VFmvqIFuoG6ivnFkx2mWhVPXexc1DY27azR0rZPo7CpuLSECFPuSItw-IUgLdl-MNEcwVLsBc_jXGpzQdzltTePbsN0pezCRviNoUg_lGYu8Od084yopF7EIqYBy204L-iWq0fT7Lg_ObbymrlYlGbDJX5KOH_ijCXh5codI-t7sVASbqSHiU-659XrL9iWpcHXq-JgW6l5mXT9kCL2jaBu9SPwUMFkJQeFStkvdZlkGrQ7yY86uRkXx0neqf5-8RKJxr17htf5IMpoLZMqx4gnCYrIPfgyqMPhACX1qCtTj-JXRcFAl5UhNyM90AzhMffO92kMjXNBHPy0f0POezONgfaeEl6B6Ol9ZLBaClVv9BJboVwUDYxmaIdcsuMyqCXqWut5iZN8n_bdUiGRI17muNEhsXHsM07TdNEUzLj62WJ14l6yXObKT58pwp7ejMVZQc2a_Ltc95fav-kSyBbAsdH_q9g8WNmqTd9reO_Q8z16I4QKmDThZ0SfSW9zf5wLn4VoYPkVUPNME6fgL6ygtO9eJeNNmEPJw2EIsx5GjSnZ2W_ZFGUZO1dDe_OheSKDilJYgUoL3JNpa5CEG2cMNbS8sEJgN3IuH_yzgYYbr0YEaEeBkhUyzcKex35HkegeVDc3Hx8ifk3onA0gJnjVL_Uip43qHF4a-6lT1ARzv06I8lvARMZGdUmwTfhvRaABaiIJcU-at_OCFduMxnZ2K5W0ek6nawbpJcoAaJkiwsUOfsW5pugy8y5xI7_3xE8_-BnAGt9dPHtXLSHF2h7WgbV1SdzEq4L4P9xl60ii962zDOpYDKSq6Cmjrue9MgZHqBqgh7h1H7wItf4qJu8RVSSWO9ac0oRF2DgjyPKlOfLXM1YQVT17PunrY1WP9GA-w1PgUhIy02bT4kDB5yqFsrWLwvs2kDMDCIGhGa-Mom15PbGiyn9ZS6gnOxGnQEa16wZnqrsm-EpmvbHpa50HoDR7SKwm"; // 예: "Bearer sl.u.AGGuzC_...."

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
