import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
const upload = multer();

app.use(cors({ origin: "*" }));

// 🔐 여기에 네 Dropbox 토큰 전체 (Bearer 포함)
const DROPBOX_TOKEN = "Bearer sl.u.AGGuzC_Aj7j91_ifSJzJ_XTeiyp0ny-eFp-CP58ImWGizvKTCvpAy5_vcCI9Q1ZvKpiEwmmwQFQ6gtQAQe7xNGvTPhXo3nrb4P9KDd2VOcs2QM0qPJn9Dtqc8yovEtoj7aJvnof81JWSTuUCUVJvb1WpuD7DqAFBbugbxYWCdTgT51Z7tvrY83ttu6sm98mckzzP7hYY3i5A5HBd6qv7U25sJbEpvv35yunYokrRinyNqcB2khQzLDyWdOwdpUZhVJwfqlopjJoFGKWuB2Fqz7OMvm7Z8MdCXnHgTmH2zpRB3Jfp6RICVBtbD2xhbTOjpMHp_C7XGZ2c3ZOj28FKVTX632F4dmZ6TatZGcLYedrmNxr-pWCnejKoJdlnrGvRgS0U_UtRd3Y8CVThL-5iyF7CFbO5fK0KHcl-dPw8iK8cp6-PxsYt0O-o3VFmvqIFuoG6ivnFkx2mWhVPXexc1DY27azR0rZPo7CpuLSECFPuSItw-IUgLdl-MNEcwVLsBc_jXGpzQdzltTePbsN0pezCRviNoUg_lGYu8Od084yopF7EIqYBy204L-iWq0fT7Lg_ObbymrlYlGbDJX5KOH_ijCXh5codI-t7sVASbqSHiU-659XrL9iWpcHXq-JgW6l5mXT9kCL2jaBu9SPwUMFkJQeFStkvdZlkGrQ7yY86uRkXx0neqf5-8RKJxr17htf5IMpoLZMqx4gnCYrIPfgyqMPhACX1qCtTj-JXRcFAl5UhNyM90AzhMffO92kMjXNBHPy0f0POezONgfaeEl6B6Ol9ZLBaClVv9BJboVwUDYxmaIdcsuMyqCXqWut5iZN8n_bdUiGRI17muNEhsXHsM07TdNEUzLj62WJ14l6yXObKT58pwp7ejMVZQc2a_Ltc95fav-kSyBbAsdH_q9g8WNmqTd9reO_Q8z16I4QKmDThZ0SfSW9zf5wLn4VoYPkVUPNME6fgL6ygtO9eJeNNmEPJw2EIsx5GjSnZ2W_ZFGUZO1dDe_OheSKDilJYgUoL3JNpa5CEG2cMNbS8sEJgN3IuH_yzgYYbr0YEaEeBkhUyzcKex35HkegeVDc3Hx8ifk3onA0gJnjVL_Uip43qHF4a-6lT1ARzv06I8lvARMZGdUmwTfhvRaABaiIJcU-at_OCFduMxnZ2K5W0ek6nawbpJcoAaJkiwsUOfsW5pugy8y5xI7_3xE8_-BnAGt9dPHtXLSHF2h7WgbV1SdzEq4L4P9xl60ii962zDOpYDKSq6Cmjrue9MgZHqBqgh7h1H7wItf4qJu8RVSSWO9ac0oRF2DgjyPKlOfLXM1YQVT17PunrY1WP9GA-w1PgUhIy02bT4kDB5yqFsrWLwvs2kDMDCIGhGa-Mom15PbGiyn9ZS6gnOxGnQEa16wZnqrsm-EpmvbHpa50HoDR7SKwm";

app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    const file = req.file;
    const name = req.body.name || "user";

    if (!file) {
      return res.status(400).json({
        ok: false,
        message: "파일 없음"
      });
    }

    const safeName = name.replace(/[^a-zA-Z0-9가-힣_-]/g, "_");
    const filename = `${safeName}_${Date.now()}.png`;

    const dropboxArg = {
      path: `/booth_uploads/accept_photos/${filename}`,
      mode: "add",
      autorename: true,
      mute: false
    };

    const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        "Authorization": DROPBOX_TOKEN,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify(dropboxArg)
      },
      body: file.buffer
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Dropbox upload error:", errText);
      return res.status(500).json({
        ok: false,
        message: "Dropbox 업로드 실패",
        detail: errText
      });
    }

    const result = await resp.json();
    return res.json({
      ok: true,
      path: result.path_display || result.path_lower || filename
    });
  } catch (err) {
    console.error("SERVER ERR:", err);
    return res.status(500).json({
      ok: false,
      message: "서버 내부 오류"
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
