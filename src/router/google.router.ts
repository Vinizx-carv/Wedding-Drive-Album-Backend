
import { Router } from "express";

import {
  getGoogleAuthUrl,
  exchangeCode,
} from "../google.js";
import { supabase } from "../services/supabase.js";
import { requireAdmin } from "../middlewares/requireAdmin.js";

const router = Router();

// Retorna a URL do Google para o frontend iniciar o OAuth.
router.get("/google", requireAdmin, async (req, res) => {
  try {
    const userId = req.adminId;

    if (!userId) {
      res.status(401).json({
        message: "Usuário não autenticado.",
      });
      return;
    }

    const authUrl = await getGoogleAuthUrl(userId);

    res.json({ url: authUrl });
  } catch (error) {
    console.error("Erro ao iniciar conexão com o Google:", error);

    res.status(500).json({
      message: "Não foi possível iniciar a conexão com o Google Drive.",
    });
  }
});

// Verifica se o administrador conectou o Google Drive.
router.get("/google/status", requireAdmin, async (req, res) => {
  try {
    const userId = req.adminId;

    if (!userId) {
      res.status(401).json({
        message: "Usuário não autenticado.",
      });
      return;
    }

    const { data, error } = await supabase
      .from("google_connections")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("Erro ao consultar status do Google Drive:", error);

      res.status(500).json({
        message: "Não foi possível verificar a conexão com o Google Drive.",
      });
      return;
    }

    res.json({
      connected: Boolean(data),
    });
  } catch (error) {
    console.error("Erro ao verificar Google Drive:", error);

    res.status(500).json({
      message: "Erro ao verificar a conexão com o Google Drive.",
    });
  }
});

// Recebe o retorno do Google.
router.get("/google/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    res.status(400).send(
      "A autorização do Google foi cancelada ou recusada.",
    );
    return;
  }

  if (typeof code !== "string" || typeof state !== "string") {
    res.status(400).send(
      "Código ou estado de autorização ausente.",
    );
    return;
  }

  try {
    await exchangeCode(code, state);

    res.send(
      "Google Drive conectado com sucesso. Você já pode fechar esta página.",
    );
  } catch (error) {
    console.error("Erro na autorização do Google:", error);

    res.status(400).send(
      "Não foi possível conectar o Google Drive. Tente novamente pelo sistema.",
    );
  }
});

export default router;
