import { Router } from "express";
import { getDrive } from "../google.js";
import { requireAdmin } from "../middlewares/requireAdmin.js";

const router = Router();

router.get("/status", requireAdmin, async (req, res) => {
  try {
    if (!req.adminId) {
      return res.status(401).json({
        connected: false,
        message: "Login necessário.",
      });
    }

    const drive = await getDrive(req.adminId);

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

    if (error instanceof Error && error.message === "GOOGLE_NOT_CONNECTED") {
      return res.status(400).json({
        connected: false,
        message: "Conecte sua conta Google antes de testar o Drive.",
      });
    }

    return res.status(500).json({
      connected: false,
      message: "Não foi possível acessar o Google Drive.",
    });
  }
});

export default router;