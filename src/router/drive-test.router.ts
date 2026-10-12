
import { Router } from "express";
import { getDrive } from "../google.js";

const router = Router();

router.get("/status", async (_req, res) => {
  try {
    const drive = await getDrive();

    const result = await drive.files.list({
      pageSize: 5,
      fields: "files(id, name, mimeType)",
    });

    return res.json({
      connected: true,
      message: "Google Drive conectado com sucesso!",
      files: result.data.files ?? [],
    });
  } catch (error) {
    console.error("Erro ao testar Google Drive:", error);

    return res.status(500).json({
      connected: false,
      message: "Não foi possível acessar o Google Drive.",
    });
  }
});

export default router;
