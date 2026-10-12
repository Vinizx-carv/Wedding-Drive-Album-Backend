
import type { Request, Response, NextFunction } from "express";
import { supabase } from "../services/supabase.js";

declare global {
  namespace Express {
    interface Request {
      adminId?: string;
    }
  }
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const authorization = req.headers.authorization;
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!token) {
    res.status(401).json({ message: "Login necessário." });
    return;
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      res.status(401).json({ message: "Sessão inválida ou expirada." });
      return;
    }

    req.adminId = data.user.id;
    next();
  } catch {
    res.status(401).json({ message: "Não foi possível validar a sessão." });
  }
}
